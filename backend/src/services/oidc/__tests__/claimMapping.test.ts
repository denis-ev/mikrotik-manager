import {
  extractGroups, mapGroupsToRole, deriveUsername, getEmail, isEmailVerified, emailDomainAllowed,
} from '../claimMapping';
import { DEFAULT_OIDC_CONFIG, type AppRole } from '../oidcConfig';

const cfg = (over = {}) => ({ ...DEFAULT_OIDC_CONFIG, ...over });

describe('extractGroups', () => {
  it('reads an array claim', () => {
    expect(extractGroups({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
  });
  it('splits a space/comma-delimited string claim', () => {
    expect(extractGroups({ roles: 'admin, netops ops' }, 'roles')).toEqual(['admin', 'netops', 'ops']);
  });
  it('returns [] when the claim is missing', () => {
    expect(extractGroups({}, 'groups')).toEqual([]);
  });
});

describe('mapGroupsToRole', () => {
  const map: Record<string, AppRole> = { admins: 'admin', ops: 'operator', staff: 'viewer' };
  it('picks the highest-privilege matching role', () => {
    expect(mapGroupsToRole(['staff', 'ops', 'admins'], map)).toBe('admin');
    expect(mapGroupsToRole(['staff', 'ops'], map)).toBe('operator');
  });
  it('returns null when no group matches', () => {
    expect(mapGroupsToRole(['unknown'], map)).toBeNull();
    expect(mapGroupsToRole([], map)).toBeNull();
  });
});

describe('deriveUsername', () => {
  it('prefers the configured username claim', () => {
    expect(deriveUsername({ preferred_username: 'jdoe', email: 'j@x.io', sub: 'abc' }, cfg())).toBe('jdoe');
  });
  it('falls back to the email local-part', () => {
    expect(deriveUsername({ email: 'jane.doe@x.io', sub: 'abc' }, cfg())).toBe('jane.doe');
  });
  it('falls back to sub', () => {
    expect(deriveUsername({ sub: 'sub-123' }, cfg())).toBe('sub-123');
  });
  it('clamps to 50 chars', () => {
    expect(deriveUsername({ preferred_username: 'x'.repeat(80) }, cfg()).length).toBe(50);
  });
});

describe('getEmail / isEmailVerified', () => {
  it('extracts a valid email', () => {
    expect(getEmail({ email: 'a@b.com' }, cfg())).toBe('a@b.com');
    expect(getEmail({ email: 'not-an-email' }, cfg())).toBeNull();
    expect(getEmail({}, cfg())).toBeNull();
  });
  it('reads email_verified as boolean or string', () => {
    expect(isEmailVerified({ email_verified: true })).toBe(true);
    expect(isEmailVerified({ email_verified: 'true' })).toBe(true);
    expect(isEmailVerified({ email_verified: false })).toBe(false);
    expect(isEmailVerified({})).toBe(false);
  });
});

describe('emailDomainAllowed', () => {
  it('allows any domain when the allowlist is empty', () => {
    expect(emailDomainAllowed('a@anywhere.io', [])).toBe(true);
  });
  it('enforces the allowlist (case-insensitive, tolerates leading @)', () => {
    expect(emailDomainAllowed('a@corp.com', ['corp.com'])).toBe(true);
    expect(emailDomainAllowed('a@CORP.com', ['@corp.com'])).toBe(true);
    expect(emailDomainAllowed('a@evil.com', ['corp.com'])).toBe(false);
    expect(emailDomainAllowed(null, ['corp.com'])).toBe(false);
  });
});
