// Pure decision-logic tests for the batched poller: resolvePollClass (per-device
// override resolution + eligibility gating) and intervalDue (the interval gate).
// No Redis/DB needed — these are pure functions. Database is mocked only so the
// module import graph never touches a real connection.
jest.mock('../../config/database');

import {
  resolvePollClass,
  intervalDue,
  PollGlobals,
  PollerDeviceRow,
  PollingConfig,
} from '../PollerService';

const globals: PollGlobals = {
  fast: 30,
  slow: 300,
  logs: 60,
  macscanEnabled: true,
  macscan: 300,
  spectralEnabled: true,
  spectral: 24 * 3600,
  apscanEnabled: true,
  apscan: 24 * 3600,
  configsnapEnabled: true,
  configsnap: 60 * 60,
  scripts: 6 * 3600,
};

function dev(overrides: Partial<PollerDeviceRow> = {}): PollerDeviceRow {
  return {
    id: 1,
    name: 'r1',
    ip_address: '10.0.0.1',
    api_port: 8728,
    api_username: 'admin',
    api_password_encrypted: 'enc',
    device_type: 'router',
    status: 'online',
    polling_config: {},
    ...overrides,
  };
}

describe('resolvePollClass — cadence resolution', () => {
  it('falls back to global seconds when the device has no override', () => {
    expect(resolvePollClass('fast', dev(), globals)).toEqual({ eligible: true, mode: 'interval', seconds: 30 });
    expect(resolvePollClass('slow', dev(), globals)).toEqual({ eligible: true, mode: 'interval', seconds: 300 });
    expect(resolvePollClass('logs', dev(), globals)).toEqual({ eligible: true, mode: 'interval', seconds: 60 });
  });

  it('applies a per-device interval override', () => {
    const cfg: PollingConfig = { fast: { seconds: 10 } };
    expect(resolvePollClass('fast', dev({ polling_config: cfg }), globals)).toEqual({
      eligible: true, mode: 'interval', seconds: 10,
    });
  });

  it('ignores a non-positive override and falls back to the global', () => {
    const cfg: PollingConfig = { fast: { seconds: 0 } };
    expect(resolvePollClass('fast', dev({ polling_config: cfg }), globals).seconds).toBe(30);
  });

  it('resolves cron mode when a cron expression is present', () => {
    const cfg: PollingConfig = { slow: { mode: 'cron', cron: '0 * * * *' } };
    const r = resolvePollClass('slow', dev({ polling_config: cfg }), globals);
    expect(r.mode).toBe('cron');
    expect(r.cron).toBe('0 * * * *');
  });

  it('falls back to interval when cron mode is set without an expression', () => {
    const cfg: PollingConfig = { slow: { mode: 'cron' } };
    const r = resolvePollClass('slow', dev({ polling_config: cfg }), globals);
    expect(r.mode).toBe('interval');
    expect(r.seconds).toBe(300);
  });
});

describe('resolvePollClass — eligibility', () => {
  it('marks a class ineligible when the device disables it (enabled:false)', () => {
    const cfg: PollingConfig = { fast: { enabled: false } };
    expect(resolvePollClass('fast', dev({ polling_config: cfg }), globals).eligible).toBe(false);
  });

  it('gates macscan on device_type switch and the global flag', () => {
    expect(resolvePollClass('macscan', dev({ device_type: 'router' }), globals).eligible).toBe(false);
    expect(resolvePollClass('macscan', dev({ device_type: 'switch' }), globals).eligible).toBe(true);
    expect(
      resolvePollClass('macscan', dev({ device_type: 'switch' }), { ...globals, macscanEnabled: false }).eligible
    ).toBe(false);
  });

  it('gates spectral and apscan on device_type wireless_ap and the global flag', () => {
    expect(resolvePollClass('spectral', dev({ device_type: 'router' }), globals).eligible).toBe(false);
    expect(resolvePollClass('spectral', dev({ device_type: 'wireless_ap' }), globals).eligible).toBe(true);
    expect(resolvePollClass('apscan', dev({ device_type: 'wireless_ap' }), globals).eligible).toBe(true);
    expect(
      resolvePollClass('apscan', dev({ device_type: 'wireless_ap' }), { ...globals, apscanEnabled: false }).eligible
    ).toBe(false);
  });

  it('gates configsnap on the global flag', () => {
    expect(resolvePollClass('configsnap', dev(), globals).eligible).toBe(true);
    expect(resolvePollClass('configsnap', dev(), { ...globals, configsnapEnabled: false }).eligible).toBe(false);
  });

  it('keeps fast/slow eligible regardless of device type', () => {
    expect(resolvePollClass('fast', dev({ device_type: 'switch' }), globals).eligible).toBe(true);
    expect(resolvePollClass('slow', dev({ device_type: 'wireless_ap' }), globals).eligible).toBe(true);
  });

  it('keeps scripts eligible for all device types and disables only via per-device enabled:false', () => {
    expect(resolvePollClass('scripts', dev({ device_type: 'router' }), globals).eligible).toBe(true);
    expect(resolvePollClass('scripts', dev({ device_type: 'switch' }), globals).eligible).toBe(true);
    expect(resolvePollClass('scripts', dev({ device_type: 'wireless_ap' }), globals).eligible).toBe(true);
    const cfg: PollingConfig = { scripts: { enabled: false } };
    expect(resolvePollClass('scripts', dev({ polling_config: cfg }), globals).eligible).toBe(false);
  });

  it('resolves the scripts global cadence when the device has no override', () => {
    expect(resolvePollClass('scripts', dev(), globals)).toEqual({
      eligible: true, mode: 'interval', seconds: 6 * 3600,
    });
  });

  it('gates logs on the device log_source (pull path only)', () => {
    // 'pull' and 'both' opt into log polling; 'syslog' and 'none' are served by
    // the push path and must not be polled.
    expect(resolvePollClass('logs', dev({ log_source: 'pull' }), globals).eligible).toBe(true);
    expect(resolvePollClass('logs', dev({ log_source: 'both' }), globals).eligible).toBe(true);
    expect(resolvePollClass('logs', dev({ log_source: 'syslog' }), globals).eligible).toBe(false);
    expect(resolvePollClass('logs', dev({ log_source: 'none' }), globals).eligible).toBe(false);
    // Absent log_source defaults to 'pull' (backward compatible).
    expect(resolvePollClass('logs', dev(), globals).eligible).toBe(true);
  });
});

describe('intervalDue — interval gate', () => {
  const now = 1_700_000_000_000;

  it('is due when the gate has never been set (lastTs 0)', () => {
    expect(intervalDue(0, 300, now)).toBe(true);
  });

  it('is not due immediately after polling', () => {
    expect(intervalDue(now, 30, now)).toBe(false);
  });

  it('is due once the effective interval has elapsed', () => {
    expect(intervalDue(now - 30_000, 30, now)).toBe(true);
  });

  it('fires an exact-interval class every tick despite sub-tick jitter (tolerance)', () => {
    // fast=30s with a 30s tick: 28s elapsed still fires thanks to the half-tick tolerance
    expect(intervalDue(now - 28_000, 30, now)).toBe(true);
  });

  it('does not fire a long-interval class early', () => {
    // slow=300s: only 100s elapsed → not due
    expect(intervalDue(now - 100_000, 300, now)).toBe(false);
  });
});
