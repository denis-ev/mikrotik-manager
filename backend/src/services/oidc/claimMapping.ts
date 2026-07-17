/**
 * Pure helpers that map OIDC ID-token / userinfo claims onto the platform's user
 * fields. Kept free of DB/network so they can be unit-tested in isolation.
 */
import type { AppRole, OidcConfig } from './oidcConfig';

const ROLE_RANK: Record<AppRole, number> = { viewer: 0, operator: 1, admin: 2 };

type Claims = Record<string, unknown>;

/** Extract the groups claim as a string[] (handles array or space/comma string). */
export function extractGroups(claims: Claims, groupsClaim: string): string[] {
  const raw = claims[groupsClaim];
  if (Array.isArray(raw)) return raw.map((g) => String(g));
  if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Highest-privilege role among the user's groups, or null if none of their
 * groups are mapped (caller decides the fallback).
 */
export function mapGroupsToRole(groups: string[], map: Record<string, AppRole>): AppRole | null {
  let best: AppRole | null = null;
  for (const g of groups) {
    const r = map[g];
    if (r && (best === null || ROLE_RANK[r] > ROLE_RANK[best])) best = r;
  }
  return best;
}

/** Derive a base username from the configured claim, falling back to email local-part then sub. */
export function deriveUsername(claims: Claims, config: OidcConfig): string {
  const fromClaim = claims[config.username_claim];
  if (typeof fromClaim === 'string' && fromClaim.trim()) return clamp(fromClaim.trim());
  const email = claims[config.email_claim];
  if (typeof email === 'string' && email.includes('@')) return clamp(email.split('@')[0]);
  return clamp(String(claims.sub ?? 'user'));
}

/** username column is VARCHAR(50). */
function clamp(s: string): string {
  return s.slice(0, 50);
}

export function getEmail(claims: Claims, config: OidcConfig): string | null {
  const v = claims[config.email_claim] ?? claims.email;
  return typeof v === 'string' && v.includes('@') ? v : null;
}

export function isEmailVerified(claims: Claims): boolean {
  return claims.email_verified === true || claims.email_verified === 'true';
}

/** True if no allowlist is configured, or the email's domain is on it. */
export function emailDomainAllowed(email: string | null, allowed: string[]): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!email || !email.includes('@')) return false;
  const domain = email.split('@')[1].toLowerCase();
  return allowed.map((d) => d.toLowerCase().replace(/^@/, '')).includes(domain);
}
