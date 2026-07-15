// Minimal 5-field cron evaluator (minute hour day-of-month month day-of-week).
// Extracted from PollerService so both the poller and per-device polling config
// can share one implementation. Supports: *, exact numbers, comma lists,
// ranges (a-b), and step values (*/n). Day-of-month and day-of-week follow the
// standard cron rule: when both are restricted the job runs if either matches;
// when only one is restricted, only that one must match.

// Returns true if the 5-part cron expression matches the given time.
// Evaluates all five fields — minute, hour, day-of-month, month, day-of-week —
// so weekly (e.g. `0 3 * * 0`) and monthly (`0 3 1 * *`) schedules fire only on
// the right day, not every day. `date` defaults to the current time.
export function cronMatchesNow(expr: string, date: Date = new Date()): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = parts;
  const now = date;
  const matchField = (field: string, val: number): boolean => {
    if (field === '*') return true;
    return field.split(',').some((f) => {
      if (f.includes('/')) {
        const [base, step] = f.split('/');
        const start = base === '*' ? 0 : Number(base);
        return val >= start && (val - start) % Number(step) === 0;
      }
      if (f.includes('-')) {
        const [lo, hi] = f.split('-').map(Number);
        return val >= lo && val <= hi;
      }
      return Number(f) === val;
    });
  };

  if (!matchField(minuteField, now.getMinutes())) return false;
  if (!matchField(hourField, now.getHours())) return false;
  if (!matchField(monthField, now.getMonth() + 1)) return false; // cron months are 1-12

  // Day-of-month (1-31) and day-of-week (0-6, Sun=0). getDay() returns 0 for Sunday.
  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';
  const domMatch = matchField(domField, now.getDate());
  const dowMatch = matchField(dowField, now.getDay());
  let dayMatch: boolean;
  if (!domRestricted && !dowRestricted) dayMatch = true;
  else if (domRestricted && dowRestricted) dayMatch = domMatch || dowMatch;
  else dayMatch = domRestricted ? domMatch : dowMatch;
  return dayMatch;
}

// True iff `expr` is 5 whitespace-separated fields, each parseable by the
// evaluator's field logic (a comma list of *, plain integers, integer ranges
// `a-b`, or step values `*/n` / `n/n`). Never throws on garbage — returns false.
export function validateCron(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every(validateField);
}

function isNonNegInt(s: string): boolean {
  return /^\d+$/.test(s);
}

function validateField(field: string): boolean {
  if (field === '') return false;
  return field.split(',').every((f) => {
    if (f === '') return false;
    if (f === '*') return true;
    if (f.includes('/')) {
      const [base, step] = f.split('/');
      if (base !== '*' && !isNonNegInt(base)) return false;
      return isNonNegInt(step) && Number(step) > 0;
    }
    if (f.includes('-')) {
      const [lo, hi] = f.split('-');
      return isNonNegInt(lo) && isNonNegInt(hi);
    }
    return isNonNegInt(f);
  });
}
