// Shared log-severity mapping used by both the pull path (DeviceCollector
// `/log print`) and the push path (syslog receiver). Kept in one place so the
// two ingest paths classify events identically.

export type AppSeverity = 'error' | 'warning' | 'info';

/**
 * Map a RouterOS log `topics` string (e.g. "system,error,critical") to the app
 * severity. Topics are the authoritative signal on the pull path.
 */
export function mapLogSeverity(topics: string): AppSeverity {
  if (topics.includes('critical') || topics.includes('error')) return 'error';
  if (topics.includes('warning')) return 'warning';
  if (topics.includes('info')) return 'info';
  return 'info';
}

/**
 * Map a numeric BSD-syslog severity (the low 3 bits of PRI, 0-7) to the app
 * severity: 0 emerg / 1 alert / 2 crit / 3 err → error, 4 warning → warning,
 * 5 notice / 6 info / 7 debug → info.
 */
export function mapSyslogSeverity(severity: number): AppSeverity {
  if (severity <= 3) return 'error';
  if (severity === 4) return 'warning';
  return 'info';
}

/**
 * Combined mapping for the syslog path: RouterOS topics take precedence (as on
 * the pull path), falling back to the numeric syslog severity when the topics
 * carry no explicit level keyword, and finally to 'info'.
 */
export function mapCombinedSeverity(
  topics: string,
  syslogSeverity: number | undefined
): AppSeverity {
  if (topics) {
    if (topics.includes('critical') || topics.includes('error')) return 'error';
    if (topics.includes('warning')) return 'warning';
    if (topics.includes('info')) return 'info';
  }
  if (syslogSeverity !== undefined) return mapSyslogSeverity(syslogSeverity);
  return 'info';
}
