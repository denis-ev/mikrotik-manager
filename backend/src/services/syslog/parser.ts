// Pure BSD-syslog parser for RouterOS remote logging. Never throws — any input
// (including non-syslog garbage) yields a best-effort result so the receiver can
// always store *something* rather than dropping a line.
//
// RouterOS `/system logging action type=remote` emits one of two wire formats:
//
//   bsd-syslog=yes:  <PRI>MMM dd HH:MM:SS hostname topics message
//   bsd-syslog=no:   <PRI>topics message
//
// where `topics` is the RouterOS comma-joined topic list (e.g.
// "system,info,account") followed by a space and the free-form message
// ("user admin logged in from 1.2.3.4 via winbox"). Some sources instead use a
// "topics: message" colon separator, which we also accept.

import { AppSeverity, mapCombinedSeverity } from '../mikrotik/logSeverity';

export interface ParsedSyslog {
  /** App-level severity (topics take precedence over the numeric PRI severity). */
  severity: AppSeverity;
  /** RouterOS topic list, comma-separated (may be empty). */
  topics: string;
  /** Free-form message body (may be empty). */
  message: string;
  /** Hostname from the RFC3164 header, when present. */
  hostname?: string;
  /** Timestamp from the RFC3164 header, when present and parseable. */
  ts?: Date;
  /** Raw PRI value, when the frame carried a valid `<PRI>` prefix. */
  pri?: number;
  /** Facility (PRI >> 3), when PRI was present. */
  facility?: number;
  /** Numeric syslog severity (PRI & 7), when PRI was present. */
  syslogSeverity?: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "MMM dd HH:MM:SS hostname " — RFC3164 timestamp + host. Day may be space- or
// zero-padded. Anchored at the start of the (post-PRI) payload.
const RFC3164_RE =
  /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+/;

/** Build a Date from RFC3164 parts (no year/timezone in the wire format). */
function buildTimestamp(mon: string, day: number, hh: number, mm: number, ss: number): Date | undefined {
  const monthIdx = MONTHS[mon.toLowerCase()];
  if (monthIdx === undefined) return undefined;
  if (day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 59) return undefined;
  const now = new Date();
  let year = now.getUTCFullYear();
  // RFC3164 omits the year. If the reconstructed date is comfortably in the
  // future, it almost certainly belongs to the previous year (Dec logs read in
  // early Jan), so roll back.
  let ts = new Date(Date.UTC(year, monthIdx, day, hh, mm, ss));
  if (ts.getTime() - now.getTime() > 24 * 3600 * 1000) {
    year -= 1;
    ts = new Date(Date.UTC(year, monthIdx, day, hh, mm, ss));
  }
  return ts;
}

/**
 * Split a RouterOS payload into its topic list and message. Topics are the
 * leading comma-separated token, or the token before the first ": " separator.
 */
export function splitTopicsMessage(payload: string): { topics: string; message: string } {
  const trimmed = payload.replace(/^\s+/, '');
  // Match the first whitespace-delimited token, tolerating a trailing colon.
  const m = /^(\S+?):?\s+([\s\S]*)$/.exec(trimmed);
  if (!m) {
    // Single token, no message. Treat as topics only if it looks like a list.
    const only = trimmed.replace(/:$/, '');
    if (only.includes(',')) return { topics: only, message: '' };
    return { topics: '', message: trimmed };
  }
  const firstToken = m[1];
  const rest = m[2];
  const hadColon = /^\S+?:\s/.test(trimmed) || /^\S+:\s/.test(trimmed);
  if (firstToken.includes(',')) {
    // Classic RouterOS: "system,info,account message"
    return { topics: firstToken, message: rest };
  }
  if (hadColon) {
    // "topic: message" single-word topic form.
    return { topics: firstToken, message: rest };
  }
  // No comma list and no colon — the whole payload is the message.
  return { topics: '', message: trimmed };
}

/** Parse a single BSD-syslog line. Never throws. */
export function parseSyslogLine(raw: string): ParsedSyslog {
  try {
    let s = (raw ?? '').replace(/\0+$/, '').replace(/[\r\n]+$/, '');

    let pri: number | undefined;
    let facility: number | undefined;
    let syslogSeverity: number | undefined;

    // PRI: "<n>" where n is 0-191.
    const priMatch = /^<(\d{1,3})>/.exec(s);
    if (priMatch) {
      const val = parseInt(priMatch[1], 10);
      if (val >= 0 && val <= 191) {
        pri = val;
        facility = val >> 3;
        syslogSeverity = val & 7;
        s = s.slice(priMatch[0].length);
      }
    }

    // Optional RFC3164 header: "MMM dd HH:MM:SS hostname ".
    let hostname: string | undefined;
    let ts: Date | undefined;
    const hdr = RFC3164_RE.exec(s);
    if (hdr) {
      const built = buildTimestamp(hdr[1], Number(hdr[2]), Number(hdr[3]), Number(hdr[4]), Number(hdr[5]));
      if (built) {
        // Only consume the header when the month token was a real month.
        ts = built;
        hostname = hdr[6];
        s = s.slice(hdr[0].length);
      }
    }

    const { topics, message } = splitTopicsMessage(s);
    const severity = mapCombinedSeverity(topics, syslogSeverity);

    const result: ParsedSyslog = { severity, topics, message };
    if (hostname !== undefined) result.hostname = hostname;
    if (ts !== undefined) result.ts = ts;
    if (pri !== undefined) {
      result.pri = pri;
      result.facility = facility;
      result.syslogSeverity = syslogSeverity;
    }
    return result;
  } catch {
    // Defensive: the logic above is total, but never let a parse failure crash
    // the UDP receiver.
    return { severity: 'info', topics: '', message: typeof raw === 'string' ? raw : '' };
  }
}
