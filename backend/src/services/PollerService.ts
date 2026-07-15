import { Queue, Worker, Job } from 'bullmq';
import { createRedisConnection } from '../config/redis';
import { query } from '../config/database';
import { DeviceCollector, DeviceRow } from './mikrotik/DeviceCollector';
import { Server as SocketServer } from 'socket.io';
import { getWriteApi } from '../config/influxdb';
import { Point } from '@influxdata/influxdb-client';
import { alertService } from './AlertService';
import { cronMatchesNow } from '../utils/cron';

// Poll classes that a combined job can run over a single connection, in the
// order they execute on the device.
export type PollClass = 'fast' | 'slow' | 'logs' | 'macscan' | 'spectral' | 'apscan' | 'configsnap';

// Sequential run order inside a combined job: cheap/frequent classes first,
// expensive scans last so a slow scan never delays the fast metrics.
const RUN_ORDER: PollClass[] = ['fast', 'logs', 'slow', 'macscan', 'configsnap', 'apscan', 'spectral'];

// The scheduler ticks every 30s. Interval gates are compared with half a tick of
// tolerance so a class configured at exactly the tick interval (e.g. fast=30s)
// fires every tick instead of drifting to every other tick on scheduling jitter.
const SCHEDULER_TICK_MS = 30_000;
const TICK_TOLERANCE_MS = SCHEDULER_TICK_MS / 2;

// Per-class polling override stored in devices.polling_config.
export interface PollClassConfig {
  mode?: 'interval' | 'cron';
  seconds?: number;
  cron?: string;
  enabled?: boolean;
}
export type PollingConfig = { [cls in PollClass]?: PollClassConfig };

// Device row as read by the poller — SELECT * also returns the polling_config JSONB.
export interface PollerDeviceRow extends DeviceRow {
  polling_config?: PollingConfig | null;
}

// Effective per-device/global cadence for one class after resolving overrides.
export interface PollGlobals {
  fast: number;             // seconds
  slow: number;             // seconds
  logs: number;             // seconds
  macscanEnabled: boolean;
  macscan: number;          // seconds
  spectralEnabled: boolean;
  spectral: number;         // seconds
  apscanEnabled: boolean;
  apscan: number;           // seconds
  configsnapEnabled: boolean;
  configsnap: number;       // seconds
}

export interface ResolvedPollClass {
  eligible: boolean;                 // global flags + device_type gating + per-device enabled
  mode: 'interval' | 'cron';
  seconds: number;                   // effective interval seconds (interval mode)
  cron?: string;                     // cron expression (cron mode)
}

// Legacy single-class jobs (kept so already-queued jobs still process) plus the
// new combined job that runs several classes over one connection.
type LegacyPollJob = {
  deviceId: number;
  type: 'fast' | 'slow' | 'logs' | 'full' | 'macscan' | 'spectral' | 'apscan' | 'configsnap';
};
type CombinedPollJob = { type: 'combined'; deviceId: number; classes: PollClass[] };
type PollJob = LegacyPollJob | CombinedPollJob;

// Global-default cadence (seconds) for a class.
function defaultSecondsFor(cls: PollClass, globals: PollGlobals): number {
  switch (cls) {
    case 'fast': return globals.fast;
    case 'slow': return globals.slow;
    case 'logs': return globals.logs;
    case 'macscan': return globals.macscan;
    case 'spectral': return globals.spectral;
    case 'apscan': return globals.apscan;
    case 'configsnap': return globals.configsnap;
  }
}

// Pure decision helper: resolve a class for a device into { eligible, mode, seconds, cron }.
// Eligibility mirrors schedulePollCycle's old gating exactly:
//   - macscan  requires the global mac_scan_enabled flag AND device_type 'switch'
//   - spectral requires spectral_scan_enabled AND device_type 'wireless_ap'
//   - apscan   requires ap_scan_enabled AND device_type 'wireless_ap'
//   - configsnap requires config_snapshot_enabled
//   - fast/slow/logs are always eligible (device already filtered to status != 'disabled')
// A per-device `enabled: false` disables the class regardless of globals.
export function resolvePollClass(
  cls: PollClass,
  device: PollerDeviceRow,
  globals: PollGlobals
): ResolvedPollClass {
  const cfg = (device.polling_config && device.polling_config[cls]) || {};

  let eligibleByGlobal: boolean;
  switch (cls) {
    case 'macscan':
      eligibleByGlobal = globals.macscanEnabled && device.device_type === 'switch';
      break;
    case 'spectral':
      eligibleByGlobal = globals.spectralEnabled && device.device_type === 'wireless_ap';
      break;
    case 'apscan':
      eligibleByGlobal = globals.apscanEnabled && device.device_type === 'wireless_ap';
      break;
    case 'configsnap':
      eligibleByGlobal = globals.configsnapEnabled;
      break;
    default:
      eligibleByGlobal = true; // fast, slow, logs
  }
  const eligible = eligibleByGlobal && cfg.enabled !== false;

  const globalSeconds = defaultSecondsFor(cls, globals);
  if (cfg.mode === 'cron' && cfg.cron) {
    return { eligible, mode: 'cron', seconds: globalSeconds, cron: cfg.cron };
  }
  const seconds = typeof cfg.seconds === 'number' && cfg.seconds > 0 ? cfg.seconds : globalSeconds;
  return { eligible, mode: 'interval', seconds };
}

// Pure interval gate: due when the elapsed time since the last enqueue reaches
// the effective interval (minus a half-tick tolerance so exact-interval classes
// fire every tick). `lastTs` is 0 when the gate has never been set.
export function intervalDue(lastTs: number, seconds: number, now: number): boolean {
  return now - lastTs >= seconds * 1000 - TICK_TOLERANCE_MS;
}

export class PollerService {
  private fastQueue: Queue;
  private slowQueue: Queue;
  private logsQueue: Queue;
  private fastWorker: Worker | null = null;
  private slowWorker: Worker | null = null;
  private logsWorker: Worker | null = null;
  private schedulerInterval: ReturnType<typeof setInterval> | null = null;
  private io: SocketServer | null = null;

  constructor() {
    const conn1 = createRedisConnection();
    const conn2 = createRedisConnection();
    const conn3 = createRedisConnection();

    this.fastQueue = new Queue('poll-fast', { connection: conn1 });
    this.slowQueue = new Queue('poll-slow', { connection: conn2 });
    this.logsQueue = new Queue('poll-logs', { connection: conn3 });
  }

  setSocketServer(io: SocketServer): void {
    this.io = io;
  }

  async start(): Promise<void> {
    this.startWorkers();
    this.startScheduler();
    console.log('PollerService started');
  }

  async stop(): Promise<void> {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
    }
    await this.fastWorker?.close();
    await this.slowWorker?.close();
    await this.logsWorker?.close();
    await this.fastQueue.close();
    await this.slowQueue.close();
    await this.logsQueue.close();
  }

  async scheduleDeviceSync(deviceId: number, type: LegacyPollJob['type'] = 'full'): Promise<void> {
    const jobData: LegacyPollJob = { deviceId, type };
    if (type === 'full') {
      await this.fastQueue.add('device-full-sync', jobData, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      });
    } else if (type === 'fast') {
      await this.fastQueue.add('device-fast-poll', jobData, { attempts: 2 });
    } else if (type === 'slow') {
      await this.slowQueue.add('device-slow-poll', jobData, { attempts: 2 });
    } else if (type === 'logs') {
      await this.logsQueue.add('device-logs-poll', jobData, { attempts: 2 });
    } else if (type === 'macscan') {
      await this.fastQueue.add('device-macscan', jobData, { attempts: 1 });
    } else if (type === 'spectral') {
      await this.slowQueue.add('device-spectral', jobData, { attempts: 1 });
    } else if (type === 'apscan') {
      await this.slowQueue.add('device-apscan', jobData, { attempts: 1 });
    } else if (type === 'configsnap') {
      await this.slowQueue.add('device-configsnap', jobData, { attempts: 1 });
    }
  }

  private startScheduler(): void {
    // Schedule polls every 30 seconds
    this.schedulerInterval = setInterval(async () => {
      await this.schedulePollCycle();
    }, SCHEDULER_TICK_MS);

    // Also run immediately
    setTimeout(() => this.schedulePollCycle(), 5000);
  }

  private async schedulePollCycle(): Promise<void> {
    try {
      const appSettings = await this.getAppSettings();
      const reverseDnsEnabled = appSettings['reverse_dns_enabled'] === true;
      const backupScheduleEnabled = appSettings['backup_schedule_enabled'] === true;
      const backupScheduleCron    = (appSettings['backup_schedule_cron'] as string) || '0 2 * * *';

      // Effective global cadences — fast/slow/logs now read their seeds instead of
      // the old hardcoded 30/300/60, and every class falls back to these when a
      // device has no per-class override in polling_config.
      const globals: PollGlobals = {
        fast: (appSettings['polling_fast_interval'] as number) || 30,
        slow: (appSettings['polling_slow_interval'] as number) || 300,
        logs: (appSettings['polling_logs_interval'] as number) || 60,
        macscanEnabled: appSettings['mac_scan_enabled'] !== false,
        macscan: (appSettings['mac_scan_interval'] as number) || 300,
        spectralEnabled: appSettings['spectral_scan_enabled'] === true,
        spectral: ((appSettings['spectral_scan_interval_hours'] as number) || 24) * 3_600,
        apscanEnabled: appSettings['ap_scan_enabled'] === true,
        apscan: ((appSettings['ap_scan_interval_hours'] as number) || 24) * 3_600,
        configsnapEnabled: appSettings['config_snapshot_enabled'] !== false,
        configsnap: ((appSettings['config_snapshot_interval_min'] as number) || 60) * 60,
      };

      const devices = await query<PollerDeviceRow>(
        `SELECT * FROM devices WHERE status != 'disabled'`
      );

      const now = Date.now();
      for (const device of devices) {
        // One pass per device: collect every class that is due this tick.
        const dueClasses: PollClass[] = [];
        for (const cls of RUN_ORDER) {
          if (await this.isDue(device, cls, globals, now)) dueClasses.push(cls);
        }
        if (dueClasses.length === 0) continue;

        // In-flight lock: if the previous combined job for this device hasn't
        // finished (worker still holds the connection), skip this tick so we
        // never open a second connection. Gates are NOT advanced when we skip,
        // so the same classes remain due next tick.
        const lockKey = `poll:inflight:${device.id}`;
        const acquired = await this.acquireInflight(lockKey);
        if (!acquired) {
          console.debug(`[Poller] Device ${device.id} still in-flight — skipping tick`);
          continue;
        }

        await this.fastQueue.add(
          'device-combined-poll',
          { type: 'combined', deviceId: device.id, classes: dueClasses } as CombinedPollJob,
          { attempts: 1 }
        );

        // Advance the gates at enqueue time (as the old per-class scheduling did),
        // so cadence is measured from when we decided to poll, not when the job ran.
        for (const cls of dueClasses) {
          const resolved = resolvePollClass(cls, device, globals);
          if (resolved.mode === 'cron') {
            // Dedup the cron minute — the tick runs every 30s, TTL 60s covers it.
            await this.setTimestamp(`poll:cronfired:${cls}:${device.id}`, now, 60);
          } else {
            // Keep the gate alive for the full interval (+ buffer), min 10 min.
            await this.setTimestamp(`poll:${cls}:${device.id}`, now, Math.max(600, resolved.seconds + 120));
          }
        }
      }

      // Reverse DNS enrichment — global, runs every 5 minutes when enabled
      if (reverseDnsEnabled) {
        const rdnsKey = 'task:reverse_dns';
        const lastRdns = await this.getTimestamp(rdnsKey);
        if (now - lastRdns > 300_000) {
          await this.setTimestamp(rdnsKey, now);
          this.resolveClientHostnames().catch((e) =>
            console.error('[Poller] Reverse DNS error:', e)
          );
        }
      }

      // Stale topology-link cleanup — runs every 15 minutes.
      // Removes neighbor rows whose reporting device missed enough slow polls
      // (slow poll = 5 min; 20-min window = 4 missed polls) without being
      // explicitly marked offline, e.g. after a crash.
      const staleLinksKey = 'task:stale_topology_links';
      const lastStaleLinks = await this.getTimestamp(staleLinksKey);
      if (now - lastStaleLinks > 900_000) {
        await this.setTimestamp(staleLinksKey, now);
        query(`DELETE FROM topology_links WHERE discovered_at < NOW() - INTERVAL '20 minutes'`)
          .catch((e) => console.error('[Poller] Stale topology-link cleanup error:', e));
      }

      // Firmware update check — runs once per day
      const firmwareKey = 'task:firmware_check';
      const lastFirmware = await this.getTimestamp(firmwareKey);
      if (now - lastFirmware > 86_400_000) {
        await this.setTimestamp(firmwareKey, now);
        this.checkAllDevicesFirmware(devices).catch((e) =>
          console.error('[Poller] Firmware check error:', e)
        );
      }

      // NetFlow data retention — runs once per day. Purges old client_traffic
      // points from InfluxDB and old daily rollups from Postgres.
      const netflowPruneKey = 'task:netflow_retention';
      const lastNetflowPrune = await this.getTimestamp(netflowPruneKey);
      if (now - lastNetflowPrune > 86_400_000) {
        await this.setTimestamp(netflowPruneKey, now, 86_400 + 3_600);
        this.purgeNetflowData().catch((e) =>
          console.error('[Poller] NetFlow retention error:', e)
        );
      }

      // Stale client pruning — runs once per hour
      // Deletes inactive client records not seen for longer than retention_clients_days.
      const pruneKey = 'task:prune_clients';
      const lastPrune = await this.getTimestamp(pruneKey);
      if (now - lastPrune > 3_600_000) {
        await this.setTimestamp(pruneKey, now);
        this.pruneStaleClients(appSettings).catch((e) =>
          console.error('[Poller] Client prune error:', e)
        );
      }

      // Scheduled backups — fire when the cron expression matches the current minute/hour.
      // Redis key with 1-hour TTL prevents double-firing within the same cron window.
      if (backupScheduleEnabled && cronMatchesNow(backupScheduleCron)) {
        const backupKey = 'task:scheduled_backup';
        const lastBackup = await this.getTimestamp(backupKey);
        if (now - lastBackup > 3_600_000) {
          await this.setTimestamp(backupKey, now);
          this.runScheduledBackups().catch((e) =>
            console.error('[Poller] Scheduled backup error:', e)
          );
        }
      }
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  }

  // Is `cls` due for `device` this tick? Combines pure cadence resolution with the
  // Redis gate state (interval timestamp or cron-fired dedup key). Returns false
  // for ineligible classes (global flags / device_type / per-device enabled:false).
  private async isDue(
    device: PollerDeviceRow,
    cls: PollClass,
    globals: PollGlobals,
    now: number
  ): Promise<boolean> {
    const resolved = resolvePollClass(cls, device, globals);
    if (!resolved.eligible) return false;

    if (resolved.mode === 'cron') {
      if (!resolved.cron || !cronMatchesNow(resolved.cron, new Date(now))) return false;
      // Fire once per matching minute — skip if the dedup key is still set.
      return !(await this.keyExists(`poll:cronfired:${cls}:${device.id}`));
    }

    const last = await this.getTimestamp(`poll:${cls}:${device.id}`);
    return intervalDue(last, resolved.seconds, now);
  }

  private async getAppSettings(): Promise<Record<string, unknown>> {
    try {
      const rows = await query<{ key: string; value: unknown }>(
        `SELECT key, value FROM app_settings
         WHERE key IN ('mac_scan_enabled', 'mac_scan_interval', 'reverse_dns_enabled',
                       'retention_clients_days', 'spectral_scan_enabled',
                       'spectral_scan_interval_hours', 'ap_scan_enabled',
                       'ap_scan_interval_hours', 'backup_schedule_enabled',
                       'backup_schedule_cron', 'polling_fast_interval',
                       'polling_slow_interval', 'polling_logs_interval',
                       'config_snapshot_enabled', 'config_snapshot_interval_min')`
      );
      const map: Record<string, unknown> = {};
      for (const row of rows) map[row.key] = row.value;
      return map;
    } catch {
      return {};
    }
  }

  private async runScheduledBackups(): Promise<void> {
    const { BackupService } = await import('./BackupService');
    const backupService = new BackupService();
    const devices = await query<{
      id: number; name: string; ip_address: string; ssh_port: number;
      ssh_username: string; ssh_password_encrypted: string;
      api_username: string; api_password_encrypted: string;
    }>(`SELECT id, name, ip_address, ssh_port, ssh_username, ssh_password_encrypted,
               api_username, api_password_encrypted
        FROM devices WHERE status = 'online'`);
    console.log(`[Poller] Starting scheduled backup for ${devices.length} online device(s)`);
    const results = await Promise.allSettled(
      devices.map((d) => backupService.createBackup(d, 'Scheduled backup', 'scheduled'))
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    console.log(`[Poller] Scheduled backup complete: ${succeeded}/${devices.length} succeeded`);
  }

  private async resolveClientHostnames(): Promise<void> {
    const { reverse } = await import('dns/promises');

    const clients = await query<{ mac_address: string; ip_address: string }>(
      `SELECT DISTINCT ON (ip_address) mac_address, ip_address
       FROM clients
       WHERE ip_address IS NOT NULL AND ip_address != ''
         AND (hostname IS NULL OR hostname = '')
       ORDER BY ip_address, last_seen DESC
       LIMIT 50`
    );
    if (clients.length === 0) return;

    const results = await Promise.allSettled(
      clients.map(async (c) => {
        const names = await reverse(c.ip_address);
        return { mac: c.mac_address, hostname: names[0] };
      })
    );

    let updated = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        await query(
          `UPDATE clients SET hostname = $1
           WHERE mac_address = $2 AND (hostname IS NULL OR hostname = '')`,
          [r.value.hostname, r.value.mac]
        );
        updated++;
      }
    }

    if (updated > 0) {
      console.log(`[Poller] Reverse DNS enriched ${updated} client hostname(s)`);
      this.io?.emit('clients:updated', {});
    }
  }

  private async purgeNetflowData(): Promise<void> {
    const rows = await query<{ key: string; value: unknown }>(
      `SELECT key, value FROM app_settings
       WHERE key IN ('netflow_retention_days', 'netflow_daily_retention_days')`
    );
    const map: Record<string, unknown> = {};
    for (const row of rows) map[row.key] = row.value;
    const detailDays = Number(map['netflow_retention_days']) || 30;
    const dailyDays = Number(map['netflow_daily_retention_days']) || 365;

    // InfluxDB: delete client_traffic points older than the detail retention
    const { DeleteAPI } = await import('@influxdata/influxdb-client-apis');
    const { getInfluxClient, org, bucket } = await import('../config/influxdb');
    const stop = new Date(Date.now() - detailDays * 86_400_000).toISOString();
    await new DeleteAPI(getInfluxClient())
      .postDelete({
        org,
        bucket,
        body: {
          start: '1970-01-01T00:00:00Z',
          stop,
          predicate: '_measurement="client_traffic"',
        },
      })
      .catch((e) => console.error('[Poller] NetFlow Influx purge error:', (e as Error).message));

    // Postgres: delete daily rollups older than the rollup retention
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM client_traffic_daily
         WHERE day < CURRENT_DATE - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [dailyDays]
    );
    const count = parseInt(result[0]?.count || '0', 10);
    if (count > 0) {
      console.log(`[Poller] NetFlow retention pruned ${count} daily rollup row(s) (> ${dailyDays} days)`);
    }
  }

  private async pruneStaleClients(settings: Record<string, unknown>): Promise<void> {
    // Delete inactive clients not seen for longer than the configured retention period.
    // Default: 7 days. Preserves any client that was active within the window so
    // short-lived or intermittent devices aren't wiped prematurely.
    const retentionDays = (settings['retention_clients_days'] as number) || 7;
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM clients
         WHERE active = FALSE
           AND last_seen < NOW() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [retentionDays]
    );
    const count = parseInt(result[0]?.count || '0', 10);
    if (count > 0) {
      console.log(`[Poller] Pruned ${count} stale client record(s) (inactive > ${retentionDays} days)`);
      this.io?.emit('clients:updated', {});
    }
  }

  async pruneStaleClientsNow(): Promise<number> {
    const rows = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'retention_clients_days'`
    );
    const retentionDays = (rows[0]?.value as number) || 7;
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM clients
         WHERE active = FALSE
           AND last_seen < NOW() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [retentionDays]
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  private async getTimestamp(key: string): Promise<number> {
    try {
      const { redis } = await import('../config/redis');
      const val = await redis.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  }

  private async setTimestamp(key: string, ts: number, ttlSec = 600): Promise<void> {
    try {
      const { redis } = await import('../config/redis');
      await redis.set(key, String(ts), 'EX', ttlSec);
    } catch { /* redis unavailable — timestamp not cached */ }
  }

  private async keyExists(key: string): Promise<boolean> {
    try {
      const { redis } = await import('../config/redis');
      return (await redis.exists(key)) === 1;
    } catch {
      return false;
    }
  }

  // In-flight lock: SET NX with a 120s safety TTL so a crashed worker can't wedge
  // a device forever. Returns true if acquired (or if Redis is down — we degrade
  // to the old always-enqueue behavior rather than stalling all polling).
  private async acquireInflight(key: string): Promise<boolean> {
    try {
      const { redis } = await import('../config/redis');
      const res = await redis.set(key, '1', 'EX', 120, 'NX');
      return res === 'OK';
    } catch {
      return true;
    }
  }

  private async releaseInflight(key: string): Promise<void> {
    try {
      const { redis } = await import('../config/redis');
      await redis.del(key);
    } catch { /* redis unavailable — lock will expire via TTL */ }
  }

  private startWorkers(): void {
    const workerOptions = {
      connection: createRedisConnection(),
      concurrency: 3,
    };

    // Fast queue carries combined jobs (one connection, all due classes) plus any
    // legacy fast/full/macscan jobs still in flight. Bumped 3 → 6 now that a tick
    // opens at most one job per device instead of several.
    this.fastWorker = new Worker(
      'poll-fast',
      async (job: Job<PollJob>) => {
        if (job.data.type === 'combined') {
          await this.processCombinedJob(job.data);
        } else {
          await this.processPollJob(job.data);
        }
      },
      { ...workerOptions, concurrency: 6 }
    );

    // Slow/logs workers stay registered to drain jobs queued before this release.
    // schedulePollCycle no longer enqueues to them.
    this.slowWorker = new Worker(
      'poll-slow',
      async (job: Job<PollJob>) => {
        if (job.data.type !== 'combined') await this.processSlowJob(job.data);
      },
      { ...workerOptions, connection: createRedisConnection() }
    );

    this.logsWorker = new Worker(
      'poll-logs',
      async (job: Job<PollJob>) => {
        if (job.data.type !== 'combined') await this.processLogsJob(job.data);
      },
      { ...workerOptions, connection: createRedisConnection() }
    );

    this.fastWorker.on('failed', (job, err) => {
      if (job) {
        this.handleDeviceFailure(job.data.deviceId, err.message);
      }
    });
  }

  // ─── Combined job: one connection, all due classes ───────────────────────────

  private async processCombinedJob(data: CombinedPollJob): Promise<void> {
    const lockKey = `poll:inflight:${data.deviceId}`;
    const device = await this.getDevice(data.deviceId);
    if (!device) {
      await this.releaseInflight(lockKey);
      return;
    }

    const collector = new DeviceCollector(device);
    try {
      try {
        await collector.connect();
      } catch (err) {
        // Connection failed — every due class is skipped and the device is marked
        // offline via the shared failure path (availability row, alerts, etc.).
        await this.handleDeviceFailure(device.id, (err as Error).message);
        return;
      }

      // Run classes sequentially in RUN_ORDER. Each is wrapped so one failing
      // class (a transient command error over a live connection) never aborts
      // the rest — the connection itself already proved the device is reachable.
      for (const cls of RUN_ORDER) {
        if (!data.classes.includes(cls)) continue;
        try {
          switch (cls) {
            case 'fast': await this.runFast(collector, device); break;
            case 'logs': await this.runLogs(collector, device); break;
            case 'slow': await this.runSlow(collector, device); break;
            case 'macscan': await this.runMacScan(collector, device); break;
            case 'configsnap': await this.runConfigSnap(collector, device); break;
            case 'apscan': await this.runApScan(collector, device); break;
            case 'spectral': await this.runSpectral(collector, device); break;
          }
        } catch (err) {
          console.error(`[Poller] Combined poll class '${cls}' failed for ${device.name}:`, (err as Error).message);
        }
      }
    } finally {
      collector.disconnect();
      await this.releaseInflight(lockKey);
    }
  }

  // ─── Per-class runners (operate on an already-connected collector) ────────────

  private async runFast(collector: DeviceCollector, device: DeviceRow): Promise<void> {
    const prevStatus = device.status; // captured from the row read at job start
    await collector.collectFast();
    await this.handleOnlineTransition(device, prevStatus);
  }

  private async runSlow(collector: DeviceCollector, device: DeviceRow): Promise<void> {
    await collector.collectSlow();
    await collector.collectNeighbors();
    await collector.collectStp();
    this.io?.emit('device:updated', { deviceId: device.id });

    // Fire device_discovered for any LLDP neighbors not matched to a managed device.
    // AlertService's per-cooldownKey cooldown prevents repeat alerts for the same neighbor.
    const unresolved = await query<{ neighbor_address: string; neighbor_identity: string }>(
      `SELECT DISTINCT neighbor_address, neighbor_identity
       FROM topology_links
       WHERE from_device_id = $1
         AND to_device_id IS NULL
         AND neighbor_address IS NOT NULL`,
      [device.id]
    );
    for (const nb of unresolved) {
      alertService.dispatch('device_discovered',
        `Unmanaged device discovered: ${nb.neighbor_identity || nb.neighbor_address} (${nb.neighbor_address})`,
        {
          details: nb.neighbor_identity || undefined,
          cooldownKey: `device_discovered:${nb.neighbor_address}`,
        }
      ).catch(() => {});
    }
  }

  private async runLogs(collector: DeviceCollector, device: DeviceRow): Promise<void> {
    await collector.collectLogs();
    this.io?.emit('events:updated', { deviceId: device.id });

    // Fire log_error / log_warning alerts if new entries appeared in the last 90s
    const recent = await query<{ severity: string; message: string }>(
      `SELECT severity, message FROM events
       WHERE device_id = $1
         AND event_time > NOW() - INTERVAL '90 seconds'
       ORDER BY event_time DESC LIMIT 1`,
      [device.id]
    );
    for (const ev of recent) {
      if (ev.severity === 'error') {
        alertService.dispatch('log_error', ev.message, {
          deviceId: device.id,
          deviceName: device.name,
        }).catch(() => {});
      } else if (ev.severity === 'warning') {
        alertService.dispatch('log_warning', ev.message, {
          deviceId: device.id,
          deviceName: device.name,
        }).catch(() => {});
      }
    }
  }

  private async runMacScan(collector: DeviceCollector, device: DeviceRow): Promise<void> {
    await collector.runMacScan();
    this.io?.emit('clients:updated', { deviceId: device.id });
  }

  private async runSpectral(collector: DeviceCollector, device: DeviceRow): Promise<void> {
    // Fetch wireless interfaces for this device so we know which radios to scan
    const ifaces = await query<{ name: string }>(
      `SELECT name FROM wireless_interfaces WHERE device_id = $1 AND disabled = FALSE`,
      [device.id]
    );
    if (ifaces.length === 0) return;

    for (const iface of ifaces) {
      const rows = await collector.collectSpectralScan(iface.name);
      if (rows.length === 0) continue;
      const aggregated = PollerService.aggregateSpectralRows(rows);
      await query(
        `INSERT INTO spectral_scan_data (device_id, interface_name, data, scan_type)
         VALUES ($1, $2, $3, 'scheduled')`,
        [device.id, iface.name, JSON.stringify(aggregated)]
      );
      console.log(`[Poller] Spectral scan saved for ${device.name}/${iface.name} (${aggregated.length} freq points)`);
    }
  }

  private async runApScan(collector: DeviceCollector, device: DeviceRow): Promise<void> {
    const ifaces = await query<{ name: string }>(
      `SELECT name FROM wireless_interfaces WHERE device_id = $1 AND disabled = FALSE`,
      [device.id]
    );
    if (ifaces.length === 0) return;

    const { lookupVendor } = await import('../utils/oui');
    const allRows: { iface: string; rows: Record<string, string>[] }[] = [];
    for (const iface of ifaces) {
      const rows = await collector.scanWireless(iface.name).catch(() => [] as Record<string, string>[]);
      if (rows.length > 0) allRows.push({ iface: iface.name, rows });
    }
    if (allRows.length === 0) return;

    const aggregated = PollerService.aggregateAPScanRows(allRows, lookupVendor);
    await query(
      `INSERT INTO ap_scan_data (device_id, data, scan_type) VALUES ($1, $2, 'scheduled')`,
      [device.id, JSON.stringify(aggregated)]
    );
    console.log(`[Poller] AP scan saved for ${device.name} (${aggregated.length} networks)`);
  }

  private async runConfigSnap(collector: DeviceCollector, _device: DeviceRow): Promise<void> {
    await collector.snapshotConfig('scheduled');
  }

  // Shared online-transition side effects: fire device_online, close the open
  // availability outage row, and emit the UI refresh events. Runs after a
  // successful fast/full poll (same as before the combined refactor).
  private async handleOnlineTransition(device: DeviceRow, prevStatus: string): Promise<void> {
    // Device came online (first poll after add, or recovery from offline)
    if (prevStatus !== 'online') {
      alertService.dispatch('device_online', `${device.name} is back online`, {
        deviceId: device.id,
        deviceName: device.name,
      }).catch(() => {});
      // Close the open outage row if one exists
      if (prevStatus === 'offline') {
        query(
          `UPDATE device_availability
           SET came_back_online_at = NOW(),
               duration_seconds = EXTRACT(EPOCH FROM (NOW() - went_offline_at))::INTEGER
           WHERE device_id = $1 AND came_back_online_at IS NULL`,
          [device.id]
        ).catch(() => {});
      }
    }

    this.io?.emit('device:updated', { deviceId: device.id });
    this.io?.emit('clients:updated', { deviceId: device.id });
  }

  // ─── Legacy single-class handlers (drain jobs queued before this release) ─────
  // Each connects a fresh collector, runs one class via the shared runner, and
  // disconnects — preserving the pre-combined behavior for already-queued jobs.

  private async processPollJob(data: LegacyPollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();

      if (data.type === 'full') {
        const prevStatus = device.status;
        await collector.collectAll();
        await this.handleOnlineTransition(device, prevStatus);
      } else if (data.type === 'macscan') {
        await this.runMacScan(collector, device);
        return;
      } else {
        await this.runFast(collector, device);
      }
    } catch (err) {
      await this.handleDeviceFailure(device.id, (err as Error).message);
      throw err;
    } finally {
      collector.disconnect();
    }
  }

  private static aggregateSpectralRows(
    rows: Record<string, string>[]
  ): { freq: number; magn: number; peak: number }[] {
    const map = new Map<number, { sum: number; count: number; peak: number }>();
    for (const row of rows) {
      const freq = parseFloat(row['freq'] || '0');
      const magn = parseInt(row['magn'] || '-120', 10);
      const peak = parseInt(row['peak'] || magn.toString(), 10);
      if (freq <= 0) continue;
      const existing = map.get(freq);
      if (existing) {
        existing.sum   += magn;
        existing.count += 1;
        existing.peak   = Math.max(existing.peak, peak);
      } else {
        map.set(freq, { sum: magn, count: 1, peak });
      }
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([freq, { sum, count, peak }]) => ({
        freq,
        magn: Math.round(sum / count),
        peak,
      }));
  }

  private static aggregateAPScanRows(
    allRows: { iface: string; rows: Record<string, string>[] }[],
    lookupVendor: (mac: string) => string
  ): unknown[] {
    interface BandEntry { bssid: string; vendor: string; signal: number; freq: number; band: string; channel_width: string }
    interface NetworkEntry { ssid: string; security: string; hidden: boolean; entries: BandEntry[] }
    const byKey = new Map<string, NetworkEntry>();

    function normBand(band: string, freq: number): string {
      if (band.includes('6ghz') || freq >= 5925) return '6 GHz';
      if (band.includes('5ghz') || (freq >= 4900 && freq < 5925)) return '5 GHz';
      return '2.4 GHz';
    }

    for (const { rows } of allRows) {
      for (const row of rows) {
        const ssid   = row['network-name'] || row['ssid'] || '';
        const bssid  = (row['address'] || row['bssid'] || '').toLowerCase();
        if (!bssid) continue;
        const rawSig = row['signal-strength'] || row['signal'] || '-100';
        const signal = parseInt(rawSig, 10) || -100;
        const freq   = parseFloat(row['frequency'] || row['channel'] || '0');
        const band   = normBand(row['band'] || row['radio-band'] || '', freq);
        const security = row['security'] || row['authentication-types'] ? (row['security'] || 'WPA') : 'open';
        const channelWidth = row['channel-width'] || '';
        const key = ssid || `hidden:${bssid}`;

        if (!byKey.has(key)) {
          byKey.set(key, { ssid, security, hidden: !ssid, entries: [] });
        }
        const net = byKey.get(key)!;
        const existing = net.entries.find(e => e.bssid === bssid && e.freq === freq);
        if (existing) {
          if (signal > existing.signal) existing.signal = signal;
        } else {
          net.entries.push({ bssid, vendor: lookupVendor(bssid), signal, freq, band, channel_width: channelWidth });
        }
      }
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const aBest = Math.max(...a.entries.map(e => e.signal));
      const bBest = Math.max(...b.entries.map(e => e.signal));
      return bBest - aBest;
    });
  }

  private async processSpectralJob(data: LegacyPollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await this.runSpectral(collector, device);
    } catch (err) {
      console.error(`[Poller] Spectral scan failed for ${device.name}:`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processApScanJob(data: LegacyPollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await this.runApScan(collector, device);
    } catch (err) {
      console.error(`[Poller] AP scan failed for ${device.name}:`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processConfigSnapJob(data: LegacyPollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await this.runConfigSnap(collector, device);
    } catch (err) {
      console.error(`[Poller] Config snapshot failed for ${device.name}:`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processSlowJob(data: LegacyPollJob): Promise<void> {
    if (data.type === 'spectral') {
      return this.processSpectralJob(data);
    }
    if (data.type === 'apscan') {
      return this.processApScanJob(data);
    }
    if (data.type === 'configsnap') {
      return this.processConfigSnapJob(data);
    }

    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await this.runSlow(collector, device);
    } catch (err) {
      await this.handleDeviceFailure(device.id, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async processLogsJob(data: LegacyPollJob): Promise<void> {
    const device = await this.getDevice(data.deviceId);
    if (!device) return;

    const collector = new DeviceCollector(device);
    try {
      await collector.connect();
      await this.runLogs(collector, device);
    } catch (err) {
      console.error(`[PollerService] Log collection failed for device ${device.id} (${device.name}):`, (err as Error).message);
    } finally {
      collector.disconnect();
    }
  }

  private async handleDeviceFailure(deviceId: number, message: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    const prevStatus = device?.status;
    await query(`UPDATE devices SET status = 'offline', updated_at = NOW() WHERE id = $1`, [deviceId]);
    if (prevStatus !== 'offline') {
      alertService.dispatch('device_offline', `${device?.name ?? `Device #${deviceId}`} is offline: ${message}`, {
        deviceId,
        deviceName: device?.name,
      }).catch(() => {});
      // Open a new availability outage row
      query(
        `INSERT INTO device_availability (device_id, went_offline_at) VALUES ($1, NOW())`,
        [deviceId]
      ).catch(() => {});
    }
    // Mark all clients for this device inactive — updateClients() never ran because connect() failed.
    await query(`UPDATE clients SET active = FALSE WHERE device_id = $1`, [deviceId]);
    // Clear stale neighbor links — the device can't re-sync to clean them up itself.
    await query(`DELETE FROM topology_links WHERE from_device_id = $1`, [deviceId]);
    // Write updated global deduped count and a per-device zero so history is continuous.
    if (device) {
      const writeApi = getWriteApi();
      writeApi.writePoint(
        new Point('client_counts')
          .tag('device_id', String(deviceId))
          .tag('device_name', device.name)
          .intField('total_clients', 0)
          .intField('wireless_clients', 0)
          .intField('wired_clients', 0)
          .timestamp(new Date())
      );
      // Recompute global deduplicated count after marking this device's clients inactive.
      const dedupedRows = await query<{ count: string }>(
        `SELECT COUNT(DISTINCT mac_address) AS count FROM clients WHERE active = TRUE`
      );
      const globalTotal = parseInt(dedupedRows[0]?.count || '0', 10);
      writeApi.writePoint(
        new Point('client_counts')
          .tag('device_id', '_global')
          .tag('device_name', '_global')
          .intField('total_clients', globalTotal)
          .timestamp(new Date())
      );
      await writeApi.flush().catch(() => {});
    }
    this.io?.emit('device:status', { deviceId, status: 'offline', message });
    this.io?.emit('clients:updated', { deviceId });
  }

  private async checkAllDevicesFirmware(devices: DeviceRow[]): Promise<void> {
    // Only check devices that are currently online to avoid long timeouts
    const onlineDevices = devices.filter((d) => d.status === 'online');
    console.log(`[Poller] Starting firmware check for ${onlineDevices.length} online device(s)`);

    for (const device of onlineDevices) {
      const collector = new DeviceCollector(device);
      try {
        await collector.connect();
        const updateInfo = await collector.checkForUpdates();

        const latestVersion = (updateInfo['latest-version'] ?? '').trim();
        const installedVersion = (updateInfo['installed-version'] ?? '').trim();
        const statusText = (updateInfo['status'] ?? '').toLowerCase();

        const hasUpdate = Boolean(
          statusText.includes('available') ||
          (latestVersion && installedVersion && latestVersion !== installedVersion)
        );

        // Read current flag before updating so we can detect first-discovery
        const current = await query<{ firmware_update_available: boolean }>(
          `SELECT firmware_update_available FROM devices WHERE id = $1`,
          [device.id]
        );
        const wasAvailable = current[0]?.firmware_update_available ?? false;

        await query(
          `UPDATE devices
           SET firmware_update_available = $1,
               latest_ros_version = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [hasUpdate, latestVersion || null, device.id]
        );

        if (hasUpdate) {
          this.io?.emit('device:updated', { deviceId: device.id });
          // Alert only on first discovery (not on every daily check)
          if (!wasAvailable) {
            const msg = latestVersion
              ? `${device.name} has a firmware update available: ${latestVersion}`
              : `${device.name} has a firmware update available`;
            alertService.dispatch('firmware_update_available', msg, {
              deviceId: device.id,
              deviceName: device.name,
              details: latestVersion ? `Current: ${installedVersion}  →  Latest: ${latestVersion}` : undefined,
            }).catch(() => {});
            console.log(`[Poller] Firmware update detected for ${device.name}: ${installedVersion} → ${latestVersion}`);
          }
        } else if (wasAvailable) {
          // Update was installed — clear the flag and notify the UI
          this.io?.emit('device:updated', { deviceId: device.id });
        }

        // RouterBOOT check — reuse the existing connection
        const rbInfo = await collector.checkRouterboardUpgrade().catch(() => ({ upgradeAvailable: false, upgradeFirmware: '', currentFirmware: '' }));
        const rbCurrentRows = await query<{ routerboard_upgrade_available: boolean }>(
          `SELECT routerboard_upgrade_available FROM devices WHERE id = $1`,
          [device.id]
        );
        const rbWasAvailable = rbCurrentRows[0]?.routerboard_upgrade_available ?? false;
        await query(
          `UPDATE devices SET routerboard_upgrade_available = $1, upgrade_firmware_version = $2, updated_at = NOW() WHERE id = $3`,
          [rbInfo.upgradeAvailable, rbInfo.upgradeFirmware || null, device.id]
        );
        if (rbInfo.upgradeAvailable) {
          this.io?.emit('device:updated', { deviceId: device.id });
          if (!rbWasAvailable) {
            const rbMsg = rbInfo.upgradeFirmware
              ? `${device.name} has a RouterBOOT upgrade available: ${rbInfo.upgradeFirmware}`
              : `${device.name} has a RouterBOOT upgrade available`;
            alertService.dispatch('firmware_update_available', rbMsg, {
              deviceId: device.id,
              deviceName: device.name,
              details: rbInfo.upgradeFirmware ? `Current: ${rbInfo.currentFirmware}  →  Upgrade: ${rbInfo.upgradeFirmware}` : undefined,
            }).catch(() => {});
            console.log(`[Poller] RouterBOOT upgrade detected for ${device.name}: ${rbInfo.currentFirmware} → ${rbInfo.upgradeFirmware}`);
          }
        } else if (rbWasAvailable) {
          this.io?.emit('device:updated', { deviceId: device.id });
        }
      } catch (err) {
        console.error(`[Poller] Firmware check failed for ${device.name}:`, (err as Error).message);
      } finally {
        collector.disconnect();
      }
    }
    console.log(`[Poller] Firmware check complete`);
  }

  private async getDevice(deviceId: number): Promise<PollerDeviceRow | null> {
    const rows = await query<PollerDeviceRow>(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
    return rows[0] || null;
  }
}
