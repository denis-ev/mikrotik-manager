import { mapLogSeverity, mapSyslogSeverity, mapCombinedSeverity } from '../logSeverity';

describe('mapLogSeverity (topics)', () => {
  it('maps error/critical topics to error', () => {
    expect(mapLogSeverity('system,error')).toBe('error');
    expect(mapLogSeverity('system,critical')).toBe('error');
  });
  it('maps warning topics to warning', () => {
    expect(mapLogSeverity('system,warning')).toBe('warning');
  });
  it('maps info and unknown topics to info', () => {
    expect(mapLogSeverity('system,info,account')).toBe('info');
    expect(mapLogSeverity('system,dhcp')).toBe('info');
    expect(mapLogSeverity('')).toBe('info');
  });
});

describe('mapSyslogSeverity (numeric PRI severity)', () => {
  it('maps 0-3 (emerg..err) to error', () => {
    expect(mapSyslogSeverity(0)).toBe('error');
    expect(mapSyslogSeverity(3)).toBe('error');
  });
  it('maps 4 (warning) to warning', () => {
    expect(mapSyslogSeverity(4)).toBe('warning');
  });
  it('maps 5-7 (notice..debug) to info', () => {
    expect(mapSyslogSeverity(5)).toBe('info');
    expect(mapSyslogSeverity(6)).toBe('info');
    expect(mapSyslogSeverity(7)).toBe('info');
  });
});

describe('mapCombinedSeverity', () => {
  it('lets topics win over the numeric severity', () => {
    expect(mapCombinedSeverity('system,warning', 6)).toBe('warning');
    expect(mapCombinedSeverity('system,error', 6)).toBe('error');
  });
  it('falls back to the numeric severity when topics have no level keyword', () => {
    expect(mapCombinedSeverity('script,foo', 3)).toBe('error');
    expect(mapCombinedSeverity('script,foo', 4)).toBe('warning');
    expect(mapCombinedSeverity('', 6)).toBe('info');
  });
  it('defaults to info when neither topics nor severity are informative', () => {
    expect(mapCombinedSeverity('', undefined)).toBe('info');
  });
});
