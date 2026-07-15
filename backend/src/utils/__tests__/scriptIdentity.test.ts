import {
  generateMarkerId,
  parseMarker,
  stripMarker,
  appendMarker,
  normalizeSource,
  hashSource,
} from '../scriptIdentity';

describe('generateMarkerId', () => {
  it('produces 8 lowercase hex characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateMarkerId()).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('is (practically) unique across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateMarkerId());
    expect(seen.size).toBe(1000);
  });
});

describe('parseMarker', () => {
  it('extracts the id from a bare marker', () => {
    expect(parseMarker('MTM:1a2f9c04')).toBe('1a2f9c04');
  });

  it('extracts the id when surrounded by operator text', () => {
    expect(parseMarker('nightly reboot MTM:deadbeef (do not edit)')).toBe('deadbeef');
  });

  it('is case-insensitive but returns lowercase', () => {
    expect(parseMarker('MTM:AABBCCDD')).toBe('aabbccdd');
  });

  it('returns null when no marker present', () => {
    expect(parseMarker('just a normal comment')).toBeNull();
  });

  it('returns null for empty / nullish input', () => {
    expect(parseMarker('')).toBeNull();
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker(undefined)).toBeNull();
  });

  it('does not match a malformed (wrong-length) marker', () => {
    expect(parseMarker('MTM:12345')).toBeNull();
    expect(parseMarker('MTM:zzzzzzzz')).toBeNull();
  });
});

describe('stripMarker', () => {
  it('removes a bare marker', () => {
    expect(stripMarker('MTM:1a2f9c04')).toBe('');
  });

  it('preserves surrounding operator text and collapses whitespace', () => {
    expect(stripMarker('nightly reboot MTM:deadbeef watchdog')).toBe('nightly reboot watchdog');
  });

  it('leaves comments without a marker untouched (trimmed)', () => {
    expect(stripMarker('  plain comment  ')).toBe('plain comment');
  });

  it('handles nullish input', () => {
    expect(stripMarker(null)).toBe('');
    expect(stripMarker(undefined)).toBe('');
  });
});

describe('appendMarker', () => {
  it('adds a marker to an empty comment', () => {
    expect(appendMarker('', 'deadbeef')).toBe('MTM:deadbeef');
  });

  it('preserves operator text with a single-space separator', () => {
    expect(appendMarker('nightly reboot', 'deadbeef')).toBe('nightly reboot MTM:deadbeef');
  });

  it('replaces an existing marker rather than duplicating it', () => {
    expect(appendMarker('nightly reboot MTM:00000000', 'deadbeef')).toBe('nightly reboot MTM:deadbeef');
  });

  it('lowercases the marker id', () => {
    expect(appendMarker('x', 'AABBCCDD')).toBe('x MTM:aabbccdd');
  });

  it('round-trips: parse(append(text, id)) === id and strip recovers text', () => {
    const text = 'keepalive watchdog';
    const withMarker = appendMarker(text, 'cafebabe');
    expect(parseMarker(withMarker)).toBe('cafebabe');
    expect(stripMarker(withMarker)).toBe(text);
  });
});

describe('normalizeSource', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeSource(':log info a\r\n:log info b')).toBe(':log info a\n:log info b');
    expect(normalizeSource(':log info a\r:log info b')).toBe(':log info a\n:log info b');
  });

  it('trims trailing whitespace per line', () => {
    expect(normalizeSource('a   \nb\t\n')).toBe('a\nb');
  });

  it('removes trailing blank lines', () => {
    expect(normalizeSource('a\nb\n\n\n')).toBe('a\nb');
  });

  it('returns empty string for nullish input', () => {
    expect(normalizeSource(null)).toBe('');
    expect(normalizeSource(undefined)).toBe('');
  });
});

describe('hashSource', () => {
  it('is stable across CRLF vs LF line endings', () => {
    expect(hashSource(':log info x\r\n:log info y')).toBe(hashSource(':log info x\n:log info y'));
  });

  it('is stable across trailing whitespace and trailing newlines', () => {
    expect(hashSource('a\nb')).toBe(hashSource('a   \nb\n\n'));
  });

  it('differs for genuinely different content', () => {
    expect(hashSource('a\nb')).not.toBe(hashSource('a\nc'));
  });

  it('produces a 64-char hex sha256 digest', () => {
    expect(hashSource('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
