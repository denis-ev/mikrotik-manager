/**
 * OIDC provider configuration, persisted as a single JSONB row in app_settings
 * under OIDC_SETTINGS_KEY. The client secret is encrypted at rest with the
 * platform's self-healing key (utils/crypto). This key is deliberately excluded
 * from the generic GET/PUT /api/settings surface (see routes/settings.ts) so the
 * secret is only ever written through the dedicated, admin-only OIDC endpoints.
 */
import { query, queryOne } from '../../config/database';
import { encrypt, decrypt } from '../../utils/crypto';

export const OIDC_SETTINGS_KEY = 'oidc_config';

export type AppRole = 'admin' | 'operator' | 'viewer';
export const APP_ROLES: AppRole[] = ['admin', 'operator', 'viewer'];

export interface OidcConfig {
  enabled: boolean;
  issuer_url: string;
  client_id: string;
  /** AES-GCM ciphertext of the client secret, or null if none set. */
  client_secret_encrypted: string | null;
  scopes: string;
  username_claim: string;
  email_claim: string;
  groups_claim: string;
  group_role_map: Record<string, AppRole>;
  default_role: AppRole;
  auto_provision: boolean;
  link_by_verified_email: boolean;
  allowed_email_domains: string[];
  button_label: string;
  /** Optional override for building the redirect URI (else derived from the request). */
  public_base_url: string;
}

export const DEFAULT_OIDC_CONFIG: OidcConfig = {
  enabled: false,
  issuer_url: '',
  client_id: '',
  client_secret_encrypted: null,
  scopes: 'openid profile email',
  username_claim: 'preferred_username',
  email_claim: 'email',
  groups_claim: 'groups',
  group_role_map: {},
  default_role: 'viewer',
  auto_provision: true,
  link_by_verified_email: true,
  allowed_email_domains: [],
  button_label: 'Sign in with SSO',
  public_base_url: '',
};

export async function loadOidcConfig(): Promise<OidcConfig> {
  const row = await queryOne<{ value: Partial<OidcConfig> }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [OIDC_SETTINGS_KEY]
  );
  return { ...DEFAULT_OIDC_CONFIG, ...(row?.value ?? {}) };
}

/**
 * Persist config. `newSecret` (plaintext) is encrypted and stored; pass undefined
 * to keep the existing secret, or '' to clear it.
 */
export async function saveOidcConfig(
  patch: Partial<OidcConfig>,
  newSecret?: string
): Promise<OidcConfig> {
  const current = await loadOidcConfig();
  const merged: OidcConfig = { ...current, ...patch };

  if (newSecret !== undefined) {
    merged.client_secret_encrypted = newSecret ? encrypt(newSecret) : null;
  }

  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [OIDC_SETTINGS_KEY, JSON.stringify(merged)]
  );
  return merged;
}

export function getClientSecret(config: OidcConfig): string | null {
  if (!config.client_secret_encrypted) return null;
  try {
    return decrypt(config.client_secret_encrypted);
  } catch {
    return null;
  }
}

/** Config shape safe to return to an admin UI — no secret material. */
export function maskedConfig(config: OidcConfig): Omit<OidcConfig, 'client_secret_encrypted'> & { has_secret: boolean } {
  const { client_secret_encrypted, ...rest } = config;
  return { ...rest, has_secret: !!client_secret_encrypted };
}
