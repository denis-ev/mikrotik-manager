// Single source of truth for "should this device's logs be pulled via
// /log print?". A device opts into pull when its log_source is 'pull' or
// 'both'; 'syslog' and 'none' devices are served (or intentionally not served)
// by the push path instead. Kept standalone so a later merge with the Phase 1
// polling refactor can relocate the guard cleanly.

export function shouldPullLogs(device: { log_source?: string | null }): boolean {
  const src = device.log_source ?? 'pull';
  return src === 'pull' || src === 'both';
}
