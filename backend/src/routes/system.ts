import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { query } from '../config/database';

const router = Router();
router.use(requireAuth);

const CURRENT_VERSION = process.env.npm_package_version || '0.0.0';
const RAW_URL = 'https://raw.githubusercontent.com/2GT-Media-Group-LLC/mikrotik-manager/main/frontend/package.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Normalise "0.11.7-beta" or "v0.11.7 Beta" → [0, 11, 7]
function parseVersion(v: string): number[] {
  return v
    .toLowerCase()
    .replace(/[^0-9.]/g, ' ')
    .trim()
    .split(/[\s.]+/)
    .slice(0, 3)
    .map(Number);
}

function isNewer(latest: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((latest[i] ?? 0) > (current[i] ?? 0)) return true;
    if ((latest[i] ?? 0) < (current[i] ?? 0)) return false;
  }
  return false;
}

// GET /api/system/version-check
// Returns { current, latest, update_available } — cached 24 h in app_settings.
router.get('/version-check', async (_req: Request, res: Response) => {
  try {
    // Check cache
    const cached = await query<{ value: { version: string; checked_at: string } }>(
      `SELECT value FROM app_settings WHERE key = 'version_check_cache'`
    );
    const row = cached[0]?.value;
    if (row && Date.now() - new Date(row.checked_at).getTime() < CACHE_TTL_MS) {
      const latestParsed = parseVersion(row.version);
      const currentParsed = parseVersion(CURRENT_VERSION);
      return res.json({
        current: CURRENT_VERSION,
        latest: row.version,
        update_available: isNewer(latestParsed, currentParsed),
      });
    }

    // Fetch latest version from GitHub
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let latestVersion = CURRENT_VERSION;
    try {
      const resp = await fetch(RAW_URL, { signal: controller.signal });
      if (resp.ok) {
        const pkg = await resp.json() as { version?: string };
        if (pkg.version) latestVersion = pkg.version;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Cache result
    await query(
      `INSERT INTO app_settings (key, value) VALUES ('version_check_cache', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify({ version: latestVersion, checked_at: new Date().toISOString() })]
    );

    return res.json({
      current: CURRENT_VERSION,
      latest: latestVersion,
      update_available: isNewer(parseVersion(latestVersion), parseVersion(CURRENT_VERSION)),
    });
  } catch {
    // Fail silently — air-gapped or unreachable GitHub
    return res.json({ current: CURRENT_VERSION, latest: null, update_available: false });
  }
});

export default router;
