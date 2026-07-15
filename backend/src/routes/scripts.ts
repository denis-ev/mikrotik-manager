import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireWrite } from '../middleware/auth';
import { DeviceCollector, DeviceRow } from '../services/mikrotik/DeviceCollector';
import {
  ScriptRegistry,
  ManagedScriptRow,
  DeviceScriptRow,
  ScriptSchedule,
  PushResult,
} from '../services/ScriptRegistry';
import {
  appendMarker,
  generateMarkerId,
  hashSource,
  normalizeSource,
  stripMarker,
} from '../utils/scriptIdentity';

const router = Router();
router.use(requireAuth);

/** Non-token users get credited as author; API tokens (negative userId) → null. */
function actorId(req: Request): number | null {
  const uid = req.user?.userId;
  return typeof uid === 'number' && uid > 0 ? uid : null;
}

/**
 * Insert a managed_scripts row, retrying on the (rare) marker_id unique
 * collision by regenerating the marker. Returns the inserted row.
 */
async function insertManagedWithMarker(fields: {
  kind: string; name: string; source: string; policy: string | null;
  schedule: ScriptSchedule | null; description: string | null; updatedBy: number | null;
}): Promise<ManagedScriptRow> {
  const source = normalizeSource(fields.source);
  const sourceHash = hashSource(source);
  for (let attempt = 0; attempt < 6; attempt++) {
    const marker = generateMarkerId();
    try {
      const rows = await query<ManagedScriptRow>(
        `INSERT INTO managed_scripts
           (marker_id, kind, name, source, source_hash, policy, schedule, description, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          marker,
          fields.kind,
          fields.name,
          source,
          sourceHash,
          fields.policy,
          fields.schedule ? JSON.stringify(fields.schedule) : null,
          fields.description,
          fields.updatedBy,
        ]
      );
      return rows[0];
    } catch (err) {
      // 23505 = unique_violation. Only retry when it's the marker that collided.
      if ((err as { code?: string }).code === '23505' && attempt < 5) continue;
      throw err;
    }
  }
  throw new Error('could not allocate a unique marker id');
}

// ─── GET /api/scripts — fleet view ──────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  const [managed, suggestions, candidates, unlinked] = await Promise.all([
    ScriptRegistry.getManagedWithDevices(),
    ScriptRegistry.getSuggestions(),
    ScriptRegistry.getCandidates(),
    ScriptRegistry.getUnlinked(),
  ]);
  res.json({ managed, suggestions, candidates, unlinked });
});

// ─── GET /api/scripts/devices/:deviceId — one device's inventory ────────────
router.get('/devices/:deviceId', async (req: Request, res: Response) => {
  const scripts = await query<DeviceScriptRow>(
    `SELECT * FROM device_scripts WHERE device_id = $1 ORDER BY kind, name`,
    [req.params.deviceId]
  );
  res.json({ scripts });
});

// ─── POST /api/scripts/managed — adopt a device row, or create net-new ──────
router.post('/managed', requireWrite, async (req: Request, res: Response) => {
  const body = req.body as {
    deviceScriptId?: number;
    kind?: string; name?: string; source?: string;
    policy?: string; schedule?: ScriptSchedule; description?: string;
  };

  // Adopt path: promote an existing device row into a managed script and mark it.
  if (body.deviceScriptId !== undefined) {
    const ds = await queryOne<DeviceScriptRow>(
      `SELECT * FROM device_scripts WHERE id = $1`,
      [body.deviceScriptId]
    );
    if (!ds) { res.status(400).json({ error: 'device script not found' }); return; }
    const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [ds.device_id]);
    if (!device) { res.status(400).json({ error: 'device not found' }); return; }

    const managed = await insertManagedWithMarker({
      kind: ds.kind,
      name: body.name?.trim() || ds.name,
      source: ds.source,
      policy: ds.policy,
      schedule: ds.schedule,
      description: body.description ?? null,
      updatedBy: actorId(req),
    });

    // Write the marker to the device's comment and link the row in_sync.
    const collector = new DeviceCollector(device);
    const newComment = appendMarker(ds.comment, managed.marker_id);
    try {
      await collector.connect();
      if (ds.kind === 'scheduler') await collector.setScheduler(ds.name, { comment: newComment });
      else await collector.setScript(ds.name, { comment: newComment });
      await query(
        `UPDATE device_scripts
         SET managed_script_id = $1, comment = $2, sync_status = 'in_sync', last_seen = NOW()
         WHERE id = $3`,
        [managed.id, newComment, ds.id]
      );
    } catch (err) {
      // Managed script exists but the device write failed — surface it; the row
      // stays unlinked and can be linked later once the device is reachable.
      res.status(502).json({ error: `managed script created but marker write failed: ${(err as Error).message}`, managed });
      collector.disconnect();
      return;
    }
    collector.disconnect();
    res.status(201).json(managed);
    return;
  }

  // Net-new path: create a managed script with no device write.
  if (!body.name?.trim() || !body.source) {
    res.status(400).json({ error: 'name and source are required' });
    return;
  }
  const managed = await insertManagedWithMarker({
    kind: body.kind === 'scheduler' ? 'scheduler' : 'script',
    name: body.name.trim(),
    source: body.source,
    policy: body.policy ?? null,
    schedule: body.schedule ?? null,
    description: body.description ?? null,
    updatedBy: actorId(req),
  });
  res.status(201).json(managed);
});

// ─── POST /api/scripts/managed/:id/link — link device rows to a managed ─────
router.post('/managed/:id/link', requireWrite, async (req: Request, res: Response) => {
  const managed = await queryOne<ManagedScriptRow>(
    `SELECT * FROM managed_scripts WHERE id = $1`,
    [req.params.id]
  );
  if (!managed) { res.status(404).json({ error: 'managed script not found' }); return; }

  const { deviceScriptIds, strategy } = req.body as {
    deviceScriptIds?: number[];
    strategy?: 'push_managed' | 'adopt_device_version';
  };
  if (!Array.isArray(deviceScriptIds) || deviceScriptIds.length === 0) {
    res.status(400).json({ error: 'deviceScriptIds array required' });
    return;
  }

  const rows = await query<DeviceScriptRow>(
    `SELECT * FROM device_scripts WHERE id = ANY($1::int[]) AND kind = $2`,
    [deviceScriptIds, managed.kind]
  );
  if (rows.length !== deviceScriptIds.length) {
    res.status(400).json({ error: 'some device scripts not found or kind mismatch' });
    return;
  }

  const differing = rows.filter((r) => r.source_hash !== managed.source_hash);
  if (differing.length > 0 && !strategy) {
    res.status(400).json({
      error: 'content differs from managed script; specify strategy',
      differing_device_ids: differing.map((r) => r.device_id),
    });
    return;
  }

  const results: PushResult[] = [];

  if (strategy === 'adopt_device_version' && differing.length > 0) {
    // Adopt the device version into the managed script. Only allowed when the
    // rows are unambiguous: a single row, or all rows share identical content.
    const hashes = new Set(rows.map((r) => r.source_hash));
    if (rows.length > 1 && hashes.size > 1) {
      res.status(400).json({ error: 'adopt_device_version requires a single row or identical content across rows' });
      return;
    }
    const src = rows[0].source;
    await query(
      `UPDATE managed_scripts
       SET source = $1, source_hash = $2, schedule = COALESCE($3, schedule),
           policy = COALESCE($4, policy), updated_by = $5, updated_at = NOW()
       WHERE id = $6`,
      [
        normalizeSource(src),
        hashSource(src),
        rows[0].schedule ? JSON.stringify(rows[0].schedule) : null,
        rows[0].policy,
        actorId(req),
        managed.id,
      ]
    );
    // Managed now equals every row's content → just write markers and link.
    for (const r of rows) results.push(await ScriptRegistry.writeMarkerAndLink(managed.id, r.id));
    res.json({ results });
    return;
  }

  // push_managed (for differing rows) or plain link (hash already equal).
  for (const r of rows) {
    if (r.source_hash === managed.source_hash) {
      results.push(await ScriptRegistry.writeMarkerAndLink(managed.id, r.id));
    } else {
      // Link in DB first (marked drifted) so pushToDevices — which only targets
      // already-linked rows — will overwrite the device with the managed source.
      await query(
        `UPDATE device_scripts SET managed_script_id = $1, sync_status = 'drifted' WHERE id = $2`,
        [managed.id, r.id]
      );
      const p = await ScriptRegistry.pushToDevices(managed.id, [r.device_id]);
      results.push(p[0] ?? { device_id: r.device_id, ok: false, error: 'push produced no result' });
    }
  }
  res.json({ results });
});

// ─── PUT /api/scripts/managed/:id — edit + auto-push to all linked ──────────
router.put('/managed/:id', requireWrite, async (req: Request, res: Response) => {
  const current = await queryOne<ManagedScriptRow>(
    `SELECT * FROM managed_scripts WHERE id = $1`,
    [req.params.id]
  );
  if (!current) { res.status(404).json({ error: 'managed script not found' }); return; }

  const body = req.body as {
    source?: string; policy?: string; schedule?: ScriptSchedule;
    description?: string; name?: string; expected_updated_at?: string;
  };

  if (!body.expected_updated_at ||
      new Date(body.expected_updated_at).getTime() !== new Date(current.updated_at).getTime()) {
    res.status(409).json({ error: 'managed script changed since it was loaded', current });
    return;
  }

  const source = body.source !== undefined ? normalizeSource(body.source) : current.source;
  const sourceHash = body.source !== undefined ? hashSource(body.source) : current.source_hash;

  const rows = await query<ManagedScriptRow>(
    `UPDATE managed_scripts SET
       name = COALESCE($1, name),
       source = $2,
       source_hash = $3,
       policy = COALESCE($4, policy),
       schedule = COALESCE($5, schedule),
       description = COALESCE($6, description),
       updated_by = $7,
       updated_at = NOW()
     WHERE id = $8
     RETURNING *`,
    [
      body.name ?? null,
      source,
      sourceHash,
      body.policy ?? null,
      body.schedule ? JSON.stringify(body.schedule) : null,
      body.description ?? null,
      actorId(req),
      current.id,
    ]
  );
  const managed = rows[0];
  const results = await ScriptRegistry.pushToDevices(managed.id);
  res.json({ managed, results });
});

// ─── POST /api/scripts/managed/:id/push — re-push to stale/failed devices ───
router.post('/managed/:id/push', requireWrite, async (req: Request, res: Response) => {
  const managed = await queryOne<ManagedScriptRow>(
    `SELECT id FROM managed_scripts WHERE id = $1`,
    [req.params.id]
  );
  if (!managed) { res.status(404).json({ error: 'managed script not found' }); return; }
  const { deviceIds } = req.body as { deviceIds?: number[] };
  const results = await ScriptRegistry.pushToDevices(managed.id, deviceIds);
  res.json({ results });
});

// ─── DELETE /api/scripts/managed/:id?remote=keep|strip-marker|delete ────────
router.delete('/managed/:id', requireWrite, async (req: Request, res: Response) => {
  const managed = await queryOne<ManagedScriptRow>(
    `SELECT * FROM managed_scripts WHERE id = $1`,
    [req.params.id]
  );
  if (!managed) { res.status(404).json({ error: 'managed script not found' }); return; }

  const remote = (req.query.remote as string) || 'keep';
  const results: PushResult[] = [];

  if (remote === 'strip-marker' || remote === 'delete') {
    const links = await query<DeviceScriptRow>(
      `SELECT * FROM device_scripts WHERE managed_script_id = $1`,
      [managed.id]
    );
    await Promise.allSettled(
      links.map(async (ds) => {
        const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [ds.device_id]);
        if (!device) { results.push({ device_id: ds.device_id, ok: false, error: 'device not found' }); return; }
        const collector = new DeviceCollector(device);
        try {
          await collector.connect();
          if (remote === 'delete') {
            if (ds.kind === 'scheduler') await collector.removeScheduler(ds.name);
            else await collector.removeScript(ds.name);
          } else {
            // strip-marker: keep the entry, drop just the marker from its comment.
            const clean = stripMarker(ds.comment);
            if (ds.kind === 'scheduler') await collector.setScheduler(ds.name, { comment: clean });
            else await collector.setScript(ds.name, { comment: clean });
          }
          results.push({ device_id: device.id, ok: true });
        } catch (err) {
          results.push({ device_id: device.id, ok: false, error: (err as Error).message });
        } finally {
          collector.disconnect();
        }
      })
    );
  }

  // FK ON DELETE SET NULL unlinks the device_scripts rows; next poll reconciles.
  await query(`DELETE FROM managed_scripts WHERE id = $1`, [managed.id]);
  res.json({ results });
});

// ─── POST /api/scripts/devices/:deviceId/refresh — force an inventory poll ──
router.post('/devices/:deviceId/refresh', requireWrite, async (req: Request, res: Response) => {
  const device = await queryOne<DeviceRow>(`SELECT * FROM devices WHERE id = $1`, [req.params.deviceId]);
  if (!device) { res.status(404).json({ error: 'Device not found' }); return; }
  const collector = new DeviceCollector(device);
  try {
    await collector.connect();
    await collector.collectScripts();
    const scripts = await query<DeviceScriptRow>(
      `SELECT * FROM device_scripts WHERE device_id = $1 ORDER BY kind, name`,
      [device.id]
    );
    res.json({ scripts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    collector.disconnect();
  }
});

export default router;
