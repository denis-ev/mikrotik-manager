import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { query } from '../config/database';
import { jwtSigningSecret, jwtVerifierSecrets } from '../utils/secrets';

export interface AuthPayload {
  userId: number;
  username: string;
  role: string;
  /** Set when the request authenticated with an API token instead of a session. */
  tokenAuth?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, jwtSigningSecret(), { expiresIn: '24h' });
}

export function verifyToken(token: string): AuthPayload {
  // Accept the current signing secret plus any prior strong secret, so a secret
  // rotation doesn't invalidate sessions already issued under the previous one.
  const secrets = jwtVerifierSecrets();
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as AuthPayload;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('invalid token');
}

/** Sign a short-lived token (e.g. the partial 2FA token) with the current secret. */
export function signRawToken(payload: object, options: jwt.SignOptions): string {
  return jwt.sign(payload, jwtSigningSecret(), options);
}

/** Verify a token that was signed with signRawToken, honoring rotated secrets. */
export function verifyRawToken<T>(token: string): T {
  const secrets = jwtVerifierSecrets();
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return jwt.verify(token, secret) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('invalid token');
}

// API tokens ("mtm_…") are hashed at rest; scope maps onto the existing role
// model (read → viewer, write → operator) so requireWrite/requireAdmin keep
// working unchanged. Admin actions always need a real session.
async function authenticateApiToken(token: string): Promise<AuthPayload | null> {
  const hash = createHash('sha256').update(token).digest('hex');
  const rows = await query<{ id: number; name: string; scope: string; expires_at: string | null }>(
    `SELECT id, name, scope, expires_at FROM api_tokens WHERE token_hash = $1`, [hash]
  ).catch(() => []);
  const t = rows[0];
  if (!t) return null;
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) return null;
  // Fire-and-forget usage tracking
  void query(`UPDATE api_tokens SET last_used_at = NOW() WHERE id = $1`, [t.id]).catch(() => {});
  return {
    userId: -t.id,
    username: `token:${t.name}`,
    role: t.scope === 'write' ? 'operator' : 'viewer',
    tokenAuth: true,
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.slice(7);

  if (token.startsWith('mtm_')) {
    authenticateApiToken(token)
      .then((payload) => {
        if (!payload) { res.status(401).json({ error: 'Invalid or expired API token' }); return; }
        req.user = payload;
        next();
      })
      .catch(() => res.status(401).json({ error: 'Invalid or expired API token' }));
    return;
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function requireWrite(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role === 'viewer') {
    res.status(403).json({ error: 'Write access denied for viewer role' });
    return;
  }
  next();
}
