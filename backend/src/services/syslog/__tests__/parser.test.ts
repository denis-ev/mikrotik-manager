import { parseSyslogLine, splitTopicsMessage } from '../parser';

describe('parseSyslogLine — RouterOS BSD-syslog', () => {
  it('parses a line WITH the RFC3164 header (bsd-syslog=yes)', () => {
    const line =
      '<134>Jul 15 12:34:56 MyRouter system,info,account user admin logged in from 10.0.0.5 via winbox';
    const r = parseSyslogLine(line);
    expect(r.pri).toBe(134);
    expect(r.facility).toBe(16); // 134 >> 3
    expect(r.syslogSeverity).toBe(6); // 134 & 7
    expect(r.hostname).toBe('MyRouter');
    expect(r.topics).toBe('system,info,account');
    expect(r.message).toBe('user admin logged in from 10.0.0.5 via winbox');
    expect(r.severity).toBe('info');
    expect(r.ts).toBeInstanceOf(Date);
    expect(r.ts!.getUTCMonth()).toBe(6); // July
    expect(r.ts!.getUTCDate()).toBe(15);
  });

  it('parses a line WITHOUT the RFC3164 header (bsd-syslog=no)', () => {
    const line = '<131>system,error login failure for user x';
    const r = parseSyslogLine(line);
    expect(r.pri).toBe(131);
    expect(r.syslogSeverity).toBe(3); // err
    expect(r.hostname).toBeUndefined();
    expect(r.ts).toBeUndefined();
    expect(r.topics).toBe('system,error');
    expect(r.message).toBe('login failure for user x');
    expect(r.severity).toBe('error'); // topics win
  });

  it('lets topics take precedence over the numeric PRI severity', () => {
    // PRI 134 → syslog severity 6 (info), but topics say warning.
    const r = parseSyslogLine('<134>system,warning link down on ether1');
    expect(r.syslogSeverity).toBe(6);
    expect(r.severity).toBe('warning');
  });

  it('falls back to numeric PRI severity when topics carry no level keyword', () => {
    // topics "script,foo" has no info/warning/error keyword → use PRI severity 3.
    const r = parseSyslogLine('<131>script,foo scheduled job ran');
    expect(r.topics).toBe('script,foo');
    expect(r.severity).toBe('error');
  });

  it('handles the "topics: message" colon form', () => {
    const r = parseSyslogLine('script: hello world');
    expect(r.pri).toBeUndefined();
    expect(r.topics).toBe('script');
    expect(r.message).toBe('hello world');
  });

  it('handles PRI edge values 0 and 191', () => {
    const zero = parseSyslogLine('<0>system,critical kernel panic');
    expect(zero.pri).toBe(0);
    expect(zero.facility).toBe(0);
    expect(zero.syslogSeverity).toBe(0);
    expect(zero.severity).toBe('error'); // topics critical

    const max = parseSyslogLine('<191>debug,trace verbose output');
    expect(max.pri).toBe(191);
    expect(max.facility).toBe(23);
    expect(max.syslogSeverity).toBe(7);
    expect(max.severity).toBe('info');
  });

  it('ignores an out-of-range PRI (treats it as no PRI)', () => {
    const r = parseSyslogLine('<999>system,info something');
    expect(r.pri).toBeUndefined();
    // "<999>system,info" — first token is "<999>system,info" (has comma) → topics
    expect(r.topics).toBe('<999>system,info');
    expect(r.message).toBe('something');
  });

  it('never throws on malformed garbage and returns info severity', () => {
    const r = parseSyslogLine('this is not syslog at all');
    expect(r.pri).toBeUndefined();
    expect(r.topics).toBe('');
    expect(r.message).toBe('this is not syslog at all');
    expect(r.severity).toBe('info');
  });

  it('handles empty and whitespace input', () => {
    expect(parseSyslogLine('').message).toBe('');
    expect(parseSyslogLine('').severity).toBe('info');
    expect(() => parseSyslogLine(undefined as unknown as string)).not.toThrow();
  });

  it('strips a trailing newline from the raw payload', () => {
    const r = parseSyslogLine('<134>system,info hello\n');
    expect(r.message).toBe('hello');
  });

  it('does not mistake a non-month first word for an RFC3164 header', () => {
    // "system" is not a month, so no header is consumed.
    const r = parseSyslogLine('<134>system,info,dhcp assigned 10.0.0.9');
    expect(r.hostname).toBeUndefined();
    expect(r.topics).toBe('system,info,dhcp');
    expect(r.message).toBe('assigned 10.0.0.9');
  });
});

describe('splitTopicsMessage', () => {
  it('splits a comma topic list from the message', () => {
    expect(splitTopicsMessage('system,info,account user logged in')).toEqual({
      topics: 'system,info,account',
      message: 'user logged in',
    });
  });

  it('treats a single comma-less word with no colon as pure message', () => {
    expect(splitTopicsMessage('justonemessage here')).toEqual({
      topics: '',
      message: 'justonemessage here',
    });
  });

  it('handles a single token that looks like a topic list', () => {
    expect(splitTopicsMessage('system,info')).toEqual({ topics: 'system,info', message: '' });
  });
});
