import { Server as SocketServer } from 'socket.io';
import { query, queryOne } from '../config/database';
import { DeviceRow } from './mikrotik/DeviceCollector';
import { appendMarker, parseMarker } from '../utils/scriptIdentity';

export interface ScriptSchedule {
  interval?: string;
  start_date?: string;
  start_time?: string;
}

export interface ManagedScriptRow {
  id: number;
  marker_id: string;
  kind: string;
  name: string;
  source: string;
  source_hash: string;
  policy: string | null;
  schedule: ScriptSchedule | null;
  description: string | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceScriptRow {
  id: number;
  device_id: number;
  kind: string;
  ros_id: string | null;
  name: string;
  source: string;
  source_hash: string;
  comment: string | null;
  policy: string | null;
  schedule: ScriptSchedule | null;
  run_count: number | null;
  last_started: string | null;
  disabled: boolean;
  managed_script_id: number | null;
  sync_status: string;
  last_seen: string;
}

export interface PushResult {
  device_id: number;
  ok: boolean;
  error?: string;
}

/**
 * Pure decision for a device_scripts row that IS linked to a managed script.
 * hash match always wins to in_sync; a prior push_failed is preserved on
 * mismatch (so a transient failure isn't silently downgraded to plain drift).
 */
export function decideSyncStatus(params: {
  hashEqual: boolean;
  currentStatus: string;
}): 'in_sync' | 'drifted' | 'push_failed' {
  if (params.hashEqual) return 'in_sync';
  if (params.currentStatus === 'push_failed') return 'push_failed';
  return 'drifted';
}

let io: SocketServer | null = null;

export class ScriptRegistry {
  static setSocketServer(server: SocketServer): void {
    io = server;
  }

  private static emitUpdated(): void {
    io?.emit('scripts:updated', {});
  }

  /**
   * Re-derive managed-script links + sync status for one device from the marker
   * in each row's comment. Never writes markers to devices. A row whose marker
   * matches no managed script is left unlinked (orphan detection is surfaced by
   * the fleet view). Runs after every collectScripts.
   */
  static async reconcileDevice(deviceId: number): Promise<void> {
    const rows = await query<{
      id: number; comment: string | null; source_hash: string; sync_status: string;
      managed_script_id: number | null;
    }>(
      `SELECT id, comment, source_hash, sync_status, managed_script_id
       FROM device_scripts WHERE device_id = $1`,
      [deviceId]
    );

    const managed = await query<{ id: number; marker_id: string; source_hash: string }>(
      `SELECT id, marker_id, source_hash FROM managed_scripts`
    );
    const byMarker = new Map<string, { id: number; source_hash: string }>();
    for (const m of managed) byMarker.set(m.marker_id.toLowerCase(), { id: m.id, source_hash: m.source_hash });

    for (const row of rows) {
      const marker = parseMarker(row.comment);
      const match = marker ? byMarker.get(marker) : undefined;

      if (!match) {
        // Unlinked (no marker, or marker points at no known managed script).
        if (row.managed_script_id !== null || row.sync_status !== 'unlinked') {
          await query(
            `UPDATE device_scripts SET managed_script_id = NULL, sync_status = 'unlinked' WHERE id = $1`,
            [row.id]
          );
        }
        continue;
      }

      const status = decideSyncStatus({
        hashEqual: row.source_hash === match.source_hash,
        currentStatus: row.sync_status,
      });
      if (row.managed_script_id !== match.id || row.sync_status !== status) {
        await query(
          `UPDATE device_scripts SET managed_script_id = $1, sync_status = $2 WHERE id = $3`,
          [match.id, status, row.id]
        );
      }
    }
  }

  /** Fetch the joined device row (creds) + device_scripts row for a device_script id. */
  private static async loadTarget(
    deviceScriptId: number
  ): Promise<{ ds: DeviceScriptRow; device: DeviceRow } | null> {
    const ds = await queryOne<DeviceScriptRow>(
      `SELECT * FROM device_scripts WHERE id = $1`,
      [deviceScriptId]
    );
    if (!ds) return null;
    const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [ds.device_id]);
    if (!device) return null;
    return { ds, device };
  }

  private static scheduleFields(schedule: ScriptSchedule | null): {
    interval?: string; startDate?: string; startTime?: string;
  } {
    return {
      interval: schedule?.interval,
      startDate: schedule?.start_date,
      startTime: schedule?.start_time,
    };
  }

  /**
   * Write the managed marker into the device's comment for an ALREADY-matching
   * copy (source hash equals the managed hash) and link the row in_sync. Used by
   * the link flow (hash-equal) and after adopt_device_version. Does not push
   * source. Offline → 'stale'; command error → 'push_failed'.
   */
  static async writeMarkerAndLink(managedId: number, deviceScriptId: number): Promise<PushResult> {
    const target = await ScriptRegistry.loadTarget(deviceScriptId);
    if (!target) return { device_id: 0, ok: false, error: 'device script not found' };
    const { ds, device } = target;
    const managed = await queryOne<ManagedScriptRow>(
      `SELECT * FROM managed_scripts WHERE id = $1`,
      [managedId]
    );
    if (!managed) return { device_id: device.id, ok: false, error: 'managed script not found' };

    const { DeviceCollector } = await import('./mikrotik/DeviceCollector');
    const collector = new DeviceCollector(device);
    const newComment = appendMarker(ds.comment, managed.marker_id);
    try {
      await collector.connect();
    } catch (err) {
      await query(`UPDATE device_scripts SET sync_status = 'stale' WHERE id = $1`, [ds.id]);
      return { device_id: device.id, ok: false, error: (err as Error).message };
    }
    try {
      if (ds.kind === 'scheduler') {
        await collector.setScheduler(ds.name, { comment: newComment });
      } else {
        await collector.setScript(ds.name, { comment: newComment });
      }
      await query(
        `UPDATE device_scripts
         SET managed_script_id = $1, comment = $2, sync_status = 'in_sync', last_seen = NOW()
         WHERE id = $3`,
        [managedId, newComment, ds.id]
      );
      return { device_id: device.id, ok: true };
    } catch (err) {
      await query(`UPDATE device_scripts SET sync_status = 'push_failed' WHERE id = $1`, [ds.id]);
      return { device_id: device.id, ok: false, error: (err as Error).message };
    } finally {
      collector.disconnect();
    }
  }

  /**
   * Push a managed script's source/policy/schedule + marker comment to devices.
   * Default target: every device currently linked to the managed script. For each
   * device: ensure the entry exists by name (set if present, add if missing),
   * preserving the device's own comment text and (re)writing just the marker.
   * Offline → 'stale'; command error → 'push_failed'. Emits scripts:updated.
   */
  static async pushToDevices(managedId: number, deviceIds?: number[]): Promise<PushResult[]> {
    const managed = await queryOne<ManagedScriptRow>(
      `SELECT * FROM managed_scripts WHERE id = $1`,
      [managedId]
    );
    if (!managed) return [];

    const params: unknown[] = [managedId];
    let where = `ds.managed_script_id = $1`;
    if (deviceIds && deviceIds.length > 0) {
      params.push(deviceIds);
      where += ` AND ds.device_id = ANY($2::int[])`;
    }
    const targets = await query<DeviceScriptRow>(
      `SELECT ds.* FROM device_scripts ds WHERE ${where}`,
      params
    );

    const { DeviceCollector } = await import('./mikrotik/DeviceCollector');
    const results: PushResult[] = [];

    await Promise.allSettled(
      targets.map(async (ds) => {
        const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [ds.device_id]);
        if (!device) {
          results.push({ device_id: ds.device_id, ok: false, error: 'device not found' });
          return;
        }
        const collector = new DeviceCollector(device);
        const newComment = appendMarker(ds.comment, managed.marker_id);
        try {
          await collector.connect();
        } catch (err) {
          await query(`UPDATE device_scripts SET sync_status = 'stale' WHERE id = $1`, [ds.id]);
          results.push({ device_id: device.id, ok: false, error: (err as Error).message });
          return;
        }
        try {
          if (managed.kind === 'scheduler') {
            const existing = await collector.getSchedulers();
            const present = existing.some((e) => e['name'] === ds.name);
            const sched = ScriptRegistry.scheduleFields(managed.schedule);
            const fields = {
              onEvent: managed.source,
              interval: sched.interval,
              startDate: sched.startDate,
              startTime: sched.startTime,
              policy: managed.policy ?? undefined,
              comment: newComment,
            };
            if (present) await collector.setScheduler(ds.name, fields);
            else await collector.addScheduler({ name: ds.name, ...fields });
          } else {
            const existing = await collector.getScripts();
            const present = existing.some((e) => e['name'] === ds.name);
            const fields = {
              source: managed.source,
              policy: managed.policy ?? undefined,
              comment: newComment,
            };
            if (present) await collector.setScript(ds.name, fields);
            else await collector.addScript({ name: ds.name, ...fields });
          }
          await query(
            `UPDATE device_scripts
             SET source = $1, source_hash = $2, comment = $3, policy = $4, schedule = $5,
                 managed_script_id = $6, sync_status = 'in_sync', last_seen = NOW()
             WHERE id = $7`,
            [
              managed.source,
              managed.source_hash,
              newComment,
              managed.policy,
              managed.schedule ? JSON.stringify(managed.schedule) : null,
              managedId,
              ds.id,
            ]
          );
          results.push({ device_id: device.id, ok: true });
        } catch (err) {
          await query(`UPDATE device_scripts SET sync_status = 'push_failed' WHERE id = $1`, [ds.id]);
          results.push({ device_id: device.id, ok: false, error: (err as Error).message });
        } finally {
          collector.disconnect();
        }
      })
    );

    ScriptRegistry.emitUpdated();
    return results;
  }

  // ─── Fleet view queries ─────────────────────────────────────────────────────

  /** Managed scripts, each with its linked device copies. */
  static async getManagedWithDevices(): Promise<unknown[]> {
    const managed = await query<ManagedScriptRow>(
      `SELECT * FROM managed_scripts ORDER BY kind, name`
    );
    if (managed.length === 0) return [];
    const links = await query<{
      device_script_id: number; device_id: number; device_name: string;
      sync_status: string; last_seen: string; name: string; managed_script_id: number;
    }>(
      `SELECT ds.id AS device_script_id, ds.device_id, d.name AS device_name,
              ds.sync_status, ds.last_seen, ds.name, ds.managed_script_id
       FROM device_scripts ds
       JOIN devices d ON d.id = ds.device_id
       WHERE ds.managed_script_id IS NOT NULL
       ORDER BY d.name`
    );
    const byManaged = new Map<number, typeof links>();
    for (const l of links) {
      const arr = byManaged.get(l.managed_script_id) ?? [];
      arr.push(l);
      byManaged.set(l.managed_script_id, arr);
    }
    return managed.map((m) => ({
      id: m.id,
      marker_id: m.marker_id,
      kind: m.kind,
      name: m.name,
      source: m.source,
      source_hash: m.source_hash,
      policy: m.policy,
      schedule: m.schedule,
      description: m.description,
      updated_at: m.updated_at,
      devices: (byManaged.get(m.id) ?? []).map((l) => ({
        device_script_id: l.device_script_id,
        device_id: l.device_id,
        device_name: l.device_name,
        sync_status: l.sync_status,
        last_seen: l.last_seen,
        name: l.name,
      })),
    }));
  }

  /** Unlinked device rows whose hash matches exactly one managed script. */
  static async getSuggestions(): Promise<unknown[]> {
    return query(
      `SELECT ds.id AS device_script_id, ds.device_id, d.name AS device_name,
              ds.kind, ds.name, m.id AS managed_script_id, m.name AS managed_name
       FROM device_scripts ds
       JOIN devices d ON d.id = ds.device_id
       JOIN managed_scripts m ON m.kind = ds.kind AND m.source_hash = ds.source_hash
       WHERE ds.managed_script_id IS NULL
         AND (SELECT COUNT(*) FROM managed_scripts m2
              WHERE m2.kind = ds.kind AND m2.source_hash = ds.source_hash) = 1
       ORDER BY d.name`
    );
  }

  /**
   * Groups of identical unlinked content across >1 device that match no managed
   * script — good candidates to promote into a new managed script.
   */
  static async getCandidates(): Promise<unknown[]> {
    const groups = await query<{ kind: string; source_hash: string; count: string; name: string }>(
      `SELECT ds.kind, ds.source_hash, COUNT(DISTINCT ds.device_id) AS count, MIN(ds.name) AS name
       FROM device_scripts ds
       WHERE ds.managed_script_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM managed_scripts m
                         WHERE m.kind = ds.kind AND m.source_hash = ds.source_hash)
       GROUP BY ds.kind, ds.source_hash
       HAVING COUNT(DISTINCT ds.device_id) > 1
       ORDER BY COUNT(DISTINCT ds.device_id) DESC`
    );
    if (groups.length === 0) return [];

    const items = await query<{
      kind: string; source_hash: string; device_script_id: number;
      device_id: number; device_name: string; name: string;
    }>(
      `SELECT ds.kind, ds.source_hash, ds.id AS device_script_id, ds.device_id,
              d.name AS device_name, ds.name
       FROM device_scripts ds
       JOIN devices d ON d.id = ds.device_id
       WHERE ds.managed_script_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM managed_scripts m
                         WHERE m.kind = ds.kind AND m.source_hash = ds.source_hash)
       ORDER BY d.name`
    );
    const key = (k: string, h: string): string => `${k}:${h}`;
    const byGroup = new Map<string, typeof items>();
    for (const it of items) {
      const arr = byGroup.get(key(it.kind, it.source_hash)) ?? [];
      arr.push(it);
      byGroup.set(key(it.kind, it.source_hash), arr);
    }
    return groups.map((g) => ({
      kind: g.kind,
      source_hash: g.source_hash,
      count: parseInt(g.count, 10),
      name: g.name,
      items: (byGroup.get(key(g.kind, g.source_hash)) ?? []).map((it) => ({
        device_script_id: it.device_script_id,
        device_id: it.device_id,
        device_name: it.device_name,
        name: it.name,
      })),
    }));
  }

  /** Every unlinked device row, with an orphaned_marker if its marker matches nothing. */
  static async getUnlinked(): Promise<unknown[]> {
    const rows = await query<{
      id: number; device_id: number; device_name: string; kind: string; name: string;
      comment: string | null; disabled: boolean; source_hash: string; last_seen: string;
    }>(
      `SELECT ds.id, ds.device_id, d.name AS device_name, ds.kind, ds.name,
              ds.comment, ds.disabled, ds.source_hash, ds.last_seen
       FROM device_scripts ds
       JOIN devices d ON d.id = ds.device_id
       WHERE ds.managed_script_id IS NULL
       ORDER BY d.name, ds.kind, ds.name`
    );
    const markers = await query<{ marker_id: string }>(`SELECT marker_id FROM managed_scripts`);
    const known = new Set(markers.map((m) => m.marker_id.toLowerCase()));
    return rows.map((r) => {
      const marker = parseMarker(r.comment);
      return {
        id: r.id,
        device_id: r.device_id,
        device_name: r.device_name,
        kind: r.kind,
        name: r.name,
        comment: r.comment,
        disabled: r.disabled,
        source_hash: r.source_hash,
        last_seen: r.last_seen,
        orphaned_marker: marker && !known.has(marker) ? marker : null,
      };
    });
  }
}
