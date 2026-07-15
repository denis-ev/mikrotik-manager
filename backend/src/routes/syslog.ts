import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { syslogReceiver } from '../services/syslog/SyslogReceiver';

const router = Router();
router.use(requireAuth);

// GET /api/syslog/status — receiver state + per-device attribution for the UI.
router.get('/status', async (_req: Request, res: Response) => {
  const settings = syslogReceiver.getSettings();
  const stats = syslogReceiver.getStats();
  const receivedByDevice = syslogReceiver.getReceivedByDevice();

  const rows = await query<{
    id: number;
    name: string;
    ip_address: string;
    log_source: string;
    last_log_at: Date | string | null;
  }>(`SELECT id, name, ip_address, log_source, last_log_at FROM devices ORDER BY name ASC`);

  // Include every device that opted into a log source plus any that have
  // actually delivered syslog (defensive — a received device should always have
  // log_source in {syslog, both}, but never hide a source that is producing data).
  const devices = rows
    .filter((d) => d.log_source !== 'none' || receivedByDevice.has(d.id))
    .map((d) => ({
      device_id: d.id,
      name: d.name,
      ip_address: d.ip_address,
      log_source: d.log_source,
      last_log_at: d.last_log_at ? new Date(d.last_log_at).toISOString() : null,
      received: receivedByDevice.get(d.id) ?? 0,
    }));

  res.json({
    enabled: settings.enabled,
    port: settings.port,
    advertised_address: settings.advertisedAddress,
    stats,
    devices,
  });
});

export default router;
