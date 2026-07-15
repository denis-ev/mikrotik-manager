import { decideSyncStatus } from '../ScriptRegistry';

// The reconcile decision for a device_scripts row that IS linked to a managed
// script. (Unlinked rows short-circuit to 'unlinked' before this is consulted.)
describe('decideSyncStatus', () => {
  it('hash match always wins to in_sync (from drifted)', () => {
    expect(decideSyncStatus({ hashEqual: true, currentStatus: 'drifted' })).toBe('in_sync');
  });

  it('hash match wins to in_sync even from push_failed', () => {
    expect(decideSyncStatus({ hashEqual: true, currentStatus: 'push_failed' })).toBe('in_sync');
  });

  it('hash match wins to in_sync from stale', () => {
    expect(decideSyncStatus({ hashEqual: true, currentStatus: 'stale' })).toBe('in_sync');
  });

  it('hash mismatch marks a previously in_sync row as drifted', () => {
    expect(decideSyncStatus({ hashEqual: false, currentStatus: 'in_sync' })).toBe('drifted');
  });

  it('hash mismatch preserves a push_failed status (not downgraded to drift)', () => {
    expect(decideSyncStatus({ hashEqual: false, currentStatus: 'push_failed' })).toBe('push_failed');
  });

  it('hash mismatch on a stale row becomes drifted', () => {
    expect(decideSyncStatus({ hashEqual: false, currentStatus: 'stale' })).toBe('drifted');
  });

  it('hash mismatch on an unlinked-then-linked row becomes drifted', () => {
    expect(decideSyncStatus({ hashEqual: false, currentStatus: 'unlinked' })).toBe('drifted');
  });

  // Full decision matrix over the (hashEqual × currentStatus) permutations.
  it('covers the decision matrix', () => {
    const statuses = ['unlinked', 'in_sync', 'drifted', 'push_failed', 'stale'];
    for (const currentStatus of statuses) {
      // hashEqual → always in_sync
      expect(decideSyncStatus({ hashEqual: true, currentStatus })).toBe('in_sync');
      // hashEqual false → push_failed preserved, everything else drifted
      const expected = currentStatus === 'push_failed' ? 'push_failed' : 'drifted';
      expect(decideSyncStatus({ hashEqual: false, currentStatus })).toBe(expected);
    }
  });
});
