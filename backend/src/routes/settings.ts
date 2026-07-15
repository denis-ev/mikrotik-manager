import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../config/database';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { netflowCollector } from '../services/netflow/NetflowCollector';
import { syslogReceiver } from '../services/syslog/SyslogReceiver';
import { validatePassword } from '../utils/passwordPolicy';

const router = Router();
router.use(requireAuth);

// GET /api/settings
router.get('/', async (_req: Request, res: Response) => {
  const settings = await query(`SELECT key, value FROM app_settings ORDER BY key`);
  const map: Record<string, unknown> = {};
  for (const s of settings as { key: string; value: unknown }[]) {
    map[s.key] = s.value;
  }
  res.json(map);
});

// PUT /api/settings
router.put('/', requireAdmin, async (req: Request, res: Response) => {
  const updates = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    await query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }
  // Apply NetFlow listener changes immediately instead of waiting for the
  // collector's periodic settings reconcile.
  if (Object.keys(updates).some((k) => k.startsWith('netflow_'))) {
    netflowCollector.reconcile().catch(() => {});
  }
  // Apply syslog listener changes immediately (enable/disable, port change).
  if (Object.keys(updates).some((k) => k.startsWith('syslog_'))) {
    syslogReceiver.reconcile().catch(() => {});
  }
  res.json({ message: 'Settings updated' });
});

// GET /api/settings/users
router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
  const users = await query(
    `SELECT id, username, role, created_at FROM users ORDER BY username`
  );
  res.json(users);
});

// POST /api/settings/users
router.post('/users', requireAdmin, async (req: Request, res: Response) => {
  const { username, password, role = 'viewer' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const pwError = validatePassword(password);
  if (pwError) {
    return res.status(400).json({ error: pwError });
  }
  const validRoles = ['admin', 'operator', 'viewer'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, operator, or viewer' });
  }

  const existing = await queryOne(`SELECT id FROM users WHERE username = $1`, [username]);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const hash = await bcrypt.hash(password, 12);
  const rows = await query<{ id: number }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
    [username, hash, role]
  );
  const created = await queryOne(
    `SELECT id, username, role, created_at FROM users WHERE id = $1`,
    [rows[0].id]
  );
  return res.status(201).json(created);
});

// PUT /api/settings/users/:id - update role and/or reset password
router.put('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  const userId = parseInt(req.params.id);
  const { role, password } = req.body;

  const existing = await queryOne<{ id: number; role: string }>(
    `SELECT id, role FROM users WHERE id = $1`,
    [userId]
  );
  if (!existing) return res.status(404).json({ error: 'User not found' });

  // Cannot demote yourself
  if (userId === req.user!.userId && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role away from admin' });
  }

  const validRoles = ['admin', 'operator', 'viewer'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (role) {
    await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId]);
  }
  if (password) {
    const pwError = validatePassword(password);
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }
    const hash = await bcrypt.hash(password, 12);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId]);
  }

  const updated = await queryOne(
    `SELECT id, username, role, created_at FROM users WHERE id = $1`,
    [userId]
  );
  return res.json(updated);
});

// DELETE /api/settings/users/:id
router.delete('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  if (parseInt(req.params.id) === req.user!.userId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const result = await query(`DELETE FROM users WHERE id = $1 RETURNING id`, [req.params.id]);
  if (!result.length) return res.status(404).json({ error: 'User not found' });
  return res.json({ message: 'User deleted' });
});

export default router;
