import { encrypt } from '../../../utils/crypto';
import { getClientSecret, maskedConfig, DEFAULT_OIDC_CONFIG, type OidcConfig } from '../oidcConfig';

describe('OIDC config secret handling', () => {
  it('decrypts a stored client secret', () => {
    const config: OidcConfig = { ...DEFAULT_OIDC_CONFIG, client_secret_encrypted: encrypt('super-secret') };
    expect(getClientSecret(config)).toBe('super-secret');
  });

  it('returns null when no secret is stored', () => {
    expect(getClientSecret({ ...DEFAULT_OIDC_CONFIG, client_secret_encrypted: null })).toBeNull();
  });

  it('masks the secret and never exposes ciphertext', () => {
    const config: OidcConfig = { ...DEFAULT_OIDC_CONFIG, client_secret_encrypted: encrypt('x') };
    const masked = maskedConfig(config);
    expect(masked.has_secret).toBe(true);
    expect('client_secret_encrypted' in masked).toBe(false);
    expect(JSON.stringify(masked)).not.toContain('client_secret_encrypted');
  });

  it('reports has_secret=false when unset', () => {
    expect(maskedConfig({ ...DEFAULT_OIDC_CONFIG, client_secret_encrypted: null }).has_secret).toBe(false);
  });
});
