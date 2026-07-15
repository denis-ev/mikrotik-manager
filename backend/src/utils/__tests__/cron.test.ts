import { cronMatchesNow, validateCron } from '../cron';

// A fixed reference time: Wed 2025-06-11 09:30 local (getDay() === 3).
const ref = new Date(2025, 5, 11, 9, 30, 0);

describe('cronMatchesNow', () => {
  it('matches an all-wildcards expression', () => {
    expect(cronMatchesNow('* * * * *', ref)).toBe(true);
  });

  it('matches an exact minute/hour', () => {
    expect(cronMatchesNow('30 9 * * *', ref)).toBe(true);
    expect(cronMatchesNow('31 9 * * *', ref)).toBe(false);
    expect(cronMatchesNow('30 10 * * *', ref)).toBe(false);
  });

  it('honors step values (*/n)', () => {
    expect(cronMatchesNow('*/30 * * * *', ref)).toBe(true);   // 30 % 30 === 0
    expect(cronMatchesNow('*/15 * * * *', ref)).toBe(true);   // 30 % 15 === 0
    expect(cronMatchesNow('*/7 * * * *', ref)).toBe(false);   // 30 % 7 !== 0
  });

  it('honors ranges (a-b)', () => {
    expect(cronMatchesNow('0-45 9 * * *', ref)).toBe(true);
    expect(cronMatchesNow('0-20 9 * * *', ref)).toBe(false);
  });

  it('honors comma lists', () => {
    expect(cronMatchesNow('0,15,30,45 9 * * *', ref)).toBe(true);
    expect(cronMatchesNow('0,15,45 9 * * *', ref)).toBe(false);
  });

  it('applies the standard day-of-month / day-of-week OR rule', () => {
    // ref is the 11th, a Wednesday (dow 3)
    expect(cronMatchesNow('30 9 11 * *', ref)).toBe(true);   // dom matches
    expect(cronMatchesNow('30 9 * * 3', ref)).toBe(true);    // dow matches
    // both restricted → OR: matches if either matches
    expect(cronMatchesNow('30 9 11 * 0', ref)).toBe(true);   // dom matches, dow doesn't
    expect(cronMatchesNow('30 9 1 * 3', ref)).toBe(true);    // dow matches, dom doesn't
    expect(cronMatchesNow('30 9 1 * 0', ref)).toBe(false);   // neither matches
  });

  it('checks the month field', () => {
    expect(cronMatchesNow('30 9 * 6 *', ref)).toBe(true);    // June
    expect(cronMatchesNow('30 9 * 7 *', ref)).toBe(false);   // July
  });

  it('returns false for fewer than 5 fields', () => {
    expect(cronMatchesNow('30 9 * *', ref)).toBe(false);
  });

  it('defaults to the current time when no date is given', () => {
    // Should not throw and should return a boolean
    expect(typeof cronMatchesNow('* * * * *')).toBe('boolean');
  });
});

describe('validateCron', () => {
  it('accepts well-formed expressions', () => {
    expect(validateCron('* * * * *')).toBe(true);
    expect(validateCron('0 2 * * *')).toBe(true);
    expect(validateCron('*/15 0-6 1,15 * 1-5')).toBe(true);
    expect(validateCron('30 9 11 6 3')).toBe(true);
    expect(validateCron('  0   2   *   *   *  ')).toBe(true); // extra whitespace
  });

  it('rejects the wrong number of fields', () => {
    expect(validateCron('* * * *')).toBe(false);       // 4 fields
    expect(validateCron('* * * * * *')).toBe(false);   // 6 fields
    expect(validateCron('')).toBe(false);
  });

  it('rejects garbage tokens', () => {
    expect(validateCron('abc * * * *')).toBe(false);
    expect(validateCron('* * * * xyz')).toBe(false);
    expect(validateCron('5- * * * *')).toBe(false);    // incomplete range
    expect(validateCron('*/ * * * *')).toBe(false);    // missing step
    expect(validateCron('*/0 * * * *')).toBe(false);   // zero step
    expect(validateCron('1,,2 * * * *')).toBe(false);  // empty list item
  });

  it('never throws on arbitrary input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => validateCron(null as any)).not.toThrow();
    expect(validateCron('@daily')).toBe(false);
  });
});
