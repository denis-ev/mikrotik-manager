// Syslog receiver — binds a UDP socket, parses pushed BSD-syslog lines from
// managed RouterOS devices, and batch-inserts them into the `events` table
// alongside the pull path. Lifecycle mirrors NetflowCollector: it binds only
// when `syslog_enabled`, reconciles settings on an interval (and on demand from
// the settings route), and refreshes its IP→device attribution map every 60s.

import * as dgram from 'dgram';
import { Server as SocketServer } from 'socket.io';
import { query } from '../../config/database';
import { parseSyslogLine } from './parser';
import { TokenBucket, Attribution, decideDisposition } from './rateLimit';

const MAP_REFRESH_MS = 60_000;
const SETTINGS_RECONCILE_MS = 60_000;
const FLUSH_INTERVAL_MS = 1_000;
const PRUNE_INTERVAL_MS = 86_400_000; // daily
const EMIT_THROTTLE_MS = 1_000;
const RATE_CAPACITY = 200; // burst
const RATE_PER_SEC = 200; // sustained per-source msg/s

interface SyslogSettings {
  enabled: boolean;
  port: number;
  advertisedAddress: string;
}

export interface SyslogStats {
  received: number;
  stored: number;
  dropped_unknown: number;
  dropped_disabled: number;
  dropped_ratelimited: number;
  parse_errors: number;
  started_at: string | null;
}

interface PendingEvent {
  deviceId: number;
  eventTime: string; // ISO
  severity: string;
  topics: string | null;
  message: string;
  rawJson: string;
}

export class SyslogReceiver {
  private socket: dgram.Socket | null = null;
  private io: SocketServer | null = null;

  private settings: SyslogSettings = { enabled: false, port: 5514, advertisedAddress: '' };
  private listening = false;
  private startedAt: string | null = null;

  // sourceIp → attribution (built from devices.ip_address + syslog_source_ip)
  private attributionByIp = new Map<string, Attribution>();
  private buckets = new Map<string, TokenBucket>();

  private pending: PendingEvent[] = [];
  private receivedByDevice = new Map<number, number>();
  private lastEmitByDevice = new Map<number, number>();

  // Stats (since process start)
  private received = 0;
  private stored = 0;
  private droppedUnknown = 0;
  private droppedDisabled = 0;
  private droppedRateLimited = 0;
  private parseErrors = 0;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private mapTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  setSocketServer(io: SocketServer): void {
    this.io = io;
  }

  async start(): Promise<void> {
    await this.refreshAttribution().catch(() => {});
    await this.reconcile();
    this.flushTimer = setInterval(() => {
      this.flush().catch((e) => console.error('[Syslog] Flush error:', e));
    }, FLUSH_INTERVAL_MS);
    this.mapTimer = setInterval(() => {
      this.refreshAttribution().catch(() => {});
    }, MAP_REFRESH_MS);
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch(() => {});
    }, SETTINGS_RECONCILE_MS);
    this.pruneTimer = setInterval(() => {
      this.prune().catch((e) => console.error('[Syslog] Retention prune error:', e));
    }, PRUNE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.mapTimer) clearInterval(this.mapTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.closeSocket();
    await this.flush().catch(() => {});
  }

  // Re-read settings and (re)bind or close the socket. Called on an interval and
  // directly by the settings route when syslog_* keys change.
  async reconcile(): Promise<void> {
    const next = await this.readSettings();
    const needsRebind =
      next.enabled !== this.settings.enabled || (next.enabled && next.port !== this.settings.port);
    this.settings = next;
    if (!needsRebind) return;

    this.closeSocket();
    if (next.enabled) {
      this.bindSocket(next.port);
    }
  }

  getStats(): SyslogStats {
    return {
      received: this.received,
      stored: this.stored,
      dropped_unknown: this.droppedUnknown,
      dropped_disabled: this.droppedDisabled,
      dropped_ratelimited: this.droppedRateLimited,
      parse_errors: this.parseErrors,
      started_at: this.startedAt,
    };
  }

  getSettings(): SyslogSettings {
    return { ...this.settings };
  }

  /** Per-device count of syslog messages accepted for storage (since start). */
  getReceivedByDevice(): Map<number, number> {
    return new Map(this.receivedByDevice);
  }

  private async readSettings(): Promise<SyslogSettings> {
    try {
      const rows = await query<{ key: string; value: unknown }>(
        `SELECT key, value FROM app_settings
         WHERE key IN ('syslog_enabled', 'syslog_port', 'syslog_advertised_address')`
      );
      const map: Record<string, unknown> = {};
      for (const row of rows) map[row.key] = row.value;
      return {
        enabled: map['syslog_enabled'] === true,
        // In Docker the container binds SYSLOG_BIND_PORT and the host port is
        // remapped via compose; syslog_port is the externally reachable port.
        port: Number(process.env.SYSLOG_BIND_PORT) || Number(map['syslog_port']) || 5514,
        advertisedAddress: typeof map['syslog_advertised_address'] === 'string'
          ? (map['syslog_advertised_address'] as string)
          : '',
      };
    } catch {
      return this.settings;
    }
  }

  private bindSocket(port: number): void {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    socket.on('error', (err) => {
      console.error(`[Syslog] Socket error: ${err.message}`);
      this.closeSocket();
    });
    socket.bind(port, () => {
      this.listening = true;
      this.startedAt = new Date().toISOString();
      console.log(`[Syslog] Receiver listening on udp/${port}`);
    });
    this.socket = socket;
  }

  private closeSocket(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
    if (this.listening) console.log('[Syslog] Receiver stopped');
    this.listening = false;
    this.startedAt = null;
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.received++;
    const ip = rinfo.address.replace(/^::ffff:/, '');

    const attr = this.attributionByIp.get(ip);
    const disposition = decideDisposition(attr);
    if (disposition === 'dropped_unknown') {
      this.droppedUnknown++;
      return;
    }
    if (disposition === 'dropped_disabled') {
      this.droppedDisabled++;
      return;
    }

    // Per-source rate limit (drop + count) before doing any parse/insert work.
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(RATE_CAPACITY, RATE_PER_SEC);
      this.buckets.set(ip, bucket);
    }
    if (!bucket.tryRemove()) {
      this.droppedRateLimited++;
      return;
    }

    const line = msg.toString('utf8');
    const parsed = parseSyslogLine(line);

    // A line without a valid PRI is not a well-formed syslog frame — flag it as
    // a parse error for diagnostics but still store it best-effort.
    if (parsed.pri === undefined) this.parseErrors++;

    const eventTime = (parsed.ts ?? new Date()).toISOString();
    const rawJson = JSON.stringify({
      pri: parsed.pri ?? null,
      facility: parsed.facility ?? null,
      host: parsed.hostname ?? null,
      raw: line,
    });

    this.pending.push({
      deviceId: attr!.deviceId,
      eventTime,
      severity: parsed.severity,
      topics: parsed.topics || null,
      message: parsed.message || line,
      rawJson,
    });
    this.receivedByDevice.set(attr!.deviceId, (this.receivedByDevice.get(attr!.deviceId) ?? 0) + 1);
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length);

    const rows: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const lastLogByDevice = new Map<number, string>();
    for (const e of batch) {
      rows.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++}::jsonb,'syslog',NULL)`);
      params.push(e.deviceId, e.eventTime, e.severity, e.topics, e.message, e.rawJson);
      const cur = lastLogByDevice.get(e.deviceId);
      if (!cur || e.eventTime > cur) lastLogByDevice.set(e.deviceId, e.eventTime);
    }

    try {
      await query(
        `INSERT INTO events (device_id, event_time, severity, topic, message, raw_json, source, log_id)
         VALUES ${rows.join(',')}`,
        params
      );
      this.stored += batch.length;
    } catch (err) {
      console.error('[Syslog] Batch insert failed:', (err as Error).message);
      return;
    }

    // Advance last_log_at per device (max), only ever moving it forward.
    for (const [deviceId, ts] of lastLogByDevice) {
      await query(
        `UPDATE devices SET last_log_at = GREATEST(last_log_at, $2::timestamptz) WHERE id = $1`,
        [deviceId, ts]
      ).catch(() => {});
    }

    // Emit events:updated, throttled to at most once per second per device.
    const now = Date.now();
    for (const deviceId of lastLogByDevice.keys()) {
      const lastEmit = this.lastEmitByDevice.get(deviceId) ?? 0;
      if (now - lastEmit >= EMIT_THROTTLE_MS) {
        this.lastEmitByDevice.set(deviceId, now);
        this.io?.emit('events:updated', { deviceId });
      }
    }
  }

  private async refreshAttribution(): Promise<void> {
    const devices = await query<{
      id: number;
      ip_address: string;
      syslog_source_ip: string | null;
      log_source: string;
    }>(`SELECT id, ip_address, syslog_source_ip, log_source FROM devices`);

    const map = new Map<string, Attribution>();
    for (const d of devices) {
      const attr: Attribution = { deviceId: d.id, logSource: d.log_source || 'pull' };
      // Explicit override wins; otherwise attribute by the management IP.
      const override = (d.syslog_source_ip || '').trim();
      if (override) {
        map.set(override, attr);
      } else if (d.ip_address) {
        map.set(d.ip_address, attr);
      }
    }
    this.attributionByIp = map;
  }

  private async prune(): Promise<void> {
    const rows = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'retention_events_days'`
    );
    const retentionDays = Number(rows[0]?.value) > 0 ? Number(rows[0]?.value) : 30;
    const result = await query<{ count: string }>(
      `WITH deleted AS (
         DELETE FROM events
         WHERE event_time < NOW() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT COUNT(*) AS count FROM deleted`,
      [retentionDays]
    );
    const count = parseInt(result[0]?.count || '0', 10);
    if (count > 0) {
      console.log(`[Syslog] Retention pruned ${count} event(s) older than ${retentionDays} days`);
    }
  }
}

export const syslogReceiver = new SyslogReceiver();
