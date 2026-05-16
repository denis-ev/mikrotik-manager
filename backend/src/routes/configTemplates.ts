import { Router, Request, Response } from 'express';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin, requireWrite } from '../middleware/auth';
import { RouterOSClient } from '../services/mikrotik/RouterOSClient';
import { decrypt } from '../utils/crypto';

const router = Router();
router.use(requireAuth);

interface ConfigTemplate {
  id: number;
  name: string;
  description: string | null;
  applies_to_type: string | null;
  template_json: {
    dns_servers?: string[];
    ntp_servers?: string[];
    syslog_host?: string;
  };
  created_at: string;
  updated_at: string;
}

// GET /api/config-templates
router.get('/', async (_req: Request, res: Response) => {
  const rows = await query<ConfigTemplate>(`SELECT * FROM config_templates ORDER BY name`);
  res.json(rows);
});

// GET /api/config-templates/:id
router.get('/:id', async (req: Request, res: Response) => {
  const row = await queryOne<ConfigTemplate>(`SELECT * FROM config_templates WHERE id = $1`, [req.params.id]);
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(row);
});

// POST /api/config-templates (admin)
router.post('/', requireAdmin, async (req: Request, res: Response) => {
  const { name, description, applies_to_type, template_json } = req.body as Partial<ConfigTemplate>;
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  const rows = await query<ConfigTemplate>(
    `INSERT INTO config_templates (name, description, applies_to_type, template_json)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name.trim(), description ?? null, applies_to_type ?? null, JSON.stringify(template_json ?? {})]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/config-templates/:id (admin)
router.put('/:id', requireAdmin, async (req: Request, res: Response) => {
  const { name, description, applies_to_type, template_json } = req.body as Partial<ConfigTemplate>;
  const rows = await query<ConfigTemplate>(
    `UPDATE config_templates SET
       name            = COALESCE($1, name),
       description     = COALESCE($2, description),
       applies_to_type = COALESCE($3, applies_to_type),
       template_json   = COALESCE($4, template_json),
       updated_at      = NOW()
     WHERE id = $5 RETURNING *`,
    [name, description, applies_to_type, template_json ? JSON.stringify(template_json) : null, req.params.id]
  );
  if (!rows[0]) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(rows[0]);
});

// DELETE /api/config-templates/:id (admin)
router.delete('/:id', requireAdmin, async (req: Request, res: Response) => {
  await query(`DELETE FROM config_templates WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/config-templates/:id/apply — push template to one or more devices (operator+)
router.post('/:id/apply', requireWrite, async (req: Request, res: Response) => {
  const template = await queryOne<ConfigTemplate>(
    `SELECT * FROM config_templates WHERE id = $1`,
    [req.params.id]
  );
  if (!template) { res.status(404).json({ error: 'Template not found' }); return; }

  const { device_ids } = req.body as { device_ids?: number[] };
  if (!Array.isArray(device_ids) || device_ids.length === 0) {
    res.status(400).json({ error: 'device_ids array required' });
    return;
  }

  const deviceRows = await query<{
    id: number; name: string; ip_address: string; api_port: number;
    api_username: string; api_password_encrypted: string;
  }>(
    `SELECT id, name, ip_address, api_port, api_username, api_password_encrypted
     FROM devices WHERE id = ANY($1::int[])`,
    [device_ids]
  );

  const tpl = template.template_json;
  const results: { device_id: number; device_name: string; ok: boolean; error?: string }[] = [];

  await Promise.allSettled(
    deviceRows.map(async (dev) => {
      const client = new RouterOSClient(
        dev.ip_address,
        dev.api_port,
        dev.api_username,
        decrypt(dev.api_password_encrypted),
        15_000
      );
      try {
        await client.connect();

        if (tpl.dns_servers && tpl.dns_servers.length > 0) {
          await client.execute('/ip/dns/set', { servers: tpl.dns_servers.join(',') });
        }

        if (tpl.ntp_servers && tpl.ntp_servers.length > 0) {
          await client.execute('/system/ntp/client/set', {
            enabled: 'yes',
            servers: tpl.ntp_servers.join(','),
          }).catch(() =>
            // RouterOS 6 uses different NTP path
            client.execute('/system/ntp/client/set', {
              enabled: 'yes',
              'primary-ntp': tpl.ntp_servers![0] ?? '',
              'secondary-ntp': tpl.ntp_servers![1] ?? '',
            })
          );
        }

        if (tpl.syslog_host) {
          // Find existing remote logging action and update it
          const actions = await client.execute('/system/logging/action/print');
          const remoteAction = (actions as Record<string, string>[]).find((a) => a.target === 'remote');
          if (remoteAction) {
            await client.execute('/system/logging/action/set', {
              '.id': remoteAction['.id'],
              'remote': tpl.syslog_host,
            });
          }
        }

        results.push({ device_id: dev.id, device_name: dev.name, ok: true });
      } catch (err) {
        results.push({ device_id: dev.id, device_name: dev.name, ok: false, error: (err as Error).message });
      } finally {
        client.disconnect();
      }
    })
  );

  res.json({ results });
});

export default router;
