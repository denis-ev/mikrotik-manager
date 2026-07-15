// Small pure helpers for the syslog receiver, split out so they can be unit
// tested without touching the UDP socket or the database.

/**
 * Per-source token bucket. Refills continuously at `ratePerSec` tokens/second up
 * to `capacity`, and `tryRemove` consumes one token if available. Used to cap a
 * single misbehaving/looping router at ~200 msg/s without a fixed window.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly ratePerSec: number,
    now: number = Date.now()
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Try to consume one token. Returns true if allowed, false if rate-limited. */
  tryRemove(now: number = Date.now()): boolean {
    const elapsedSec = Math.max(0, (now - this.last) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface Attribution {
  deviceId: number;
  logSource: string; // 'pull' | 'syslog' | 'both' | 'none'
}

export type Disposition = 'store' | 'dropped_unknown' | 'dropped_disabled';

/**
 * Decide what to do with a syslog line given the attribution of its source IP.
 * Unknown source → dropped_unknown; a known device whose log_source excludes
 * syslog (i.e. 'pull' or 'none') → dropped_disabled; otherwise store.
 */
export function decideDisposition(attr: Attribution | undefined): Disposition {
  if (!attr) return 'dropped_unknown';
  if (attr.logSource === 'syslog' || attr.logSource === 'both') return 'store';
  return 'dropped_disabled';
}
