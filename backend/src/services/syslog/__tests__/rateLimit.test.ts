import { TokenBucket, decideDisposition } from '../rateLimit';

describe('TokenBucket', () => {
  it('allows up to capacity in a burst, then rate-limits', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(5, 5, t0);
    // 5 immediate allows at the same instant
    for (let i = 0; i < 5; i++) expect(bucket.tryRemove(t0)).toBe(true);
    // 6th at the same instant is denied
    expect(bucket.tryRemove(t0)).toBe(false);
  });

  it('refills continuously over time', () => {
    const t0 = 2_000_000;
    const bucket = new TokenBucket(10, 10, t0); // 10 tokens/sec
    for (let i = 0; i < 10; i++) bucket.tryRemove(t0);
    expect(bucket.tryRemove(t0)).toBe(false);
    // 500ms later → +5 tokens
    const t1 = t0 + 500;
    for (let i = 0; i < 5; i++) expect(bucket.tryRemove(t1)).toBe(true);
    expect(bucket.tryRemove(t1)).toBe(false);
  });

  it('never exceeds capacity even after a long idle', () => {
    const t0 = 3_000_000;
    const bucket = new TokenBucket(3, 3, t0);
    // idle for an hour then try to drain — capacity still caps at 3
    const t1 = t0 + 3_600_000;
    expect(bucket.tryRemove(t1)).toBe(true);
    expect(bucket.tryRemove(t1)).toBe(true);
    expect(bucket.tryRemove(t1)).toBe(true);
    expect(bucket.tryRemove(t1)).toBe(false);
  });
});

describe('decideDisposition', () => {
  it('drops messages from unknown source IPs', () => {
    expect(decideDisposition(undefined)).toBe('dropped_unknown');
  });
  it('stores when the device log_source includes syslog', () => {
    expect(decideDisposition({ deviceId: 1, logSource: 'syslog' })).toBe('store');
    expect(decideDisposition({ deviceId: 1, logSource: 'both' })).toBe('store');
  });
  it('drops as disabled when the device does not use syslog', () => {
    expect(decideDisposition({ deviceId: 1, logSource: 'pull' })).toBe('dropped_disabled');
    expect(decideDisposition({ deviceId: 1, logSource: 'none' })).toBe('dropped_disabled');
  });
});
