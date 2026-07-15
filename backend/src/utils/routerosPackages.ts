// Pure helpers for RouterOS package naming, download URLs, and version comparison.
//
// MikroTik ships each release as .npk packages under
// https://download.mikrotik.com/routeros/<version>/. File naming differs by major
// line:
//   v7+: routeros-<version>-<arch>.npk   (e.g. routeros-7.15.3-arm.npk)
//   v6:  routeros-<arch>-<version>.npk   (e.g. routeros-arm-6.49.10.npk)
// Extra (non-bundle) packages follow <pkg>-<version>-<arch>.npk on v7.
//
// Kept dependency-free so it can be unit-tested and reused by the orchestrator,
// PackageStore, and routes without pulling in the RouterOS API client.

const DOWNLOAD_BASE = 'https://download.mikrotik.com/routeros';

/** Leading integer of a RouterOS version string ("7.15.3" → 7, "6.49" → 6). */
export function majorOf(version: string): number {
  const m = /^(\d+)/.exec(version.trim());
  return m ? parseInt(m[1], 10) : 0;
}

/** The base RouterOS bundle .npk file name for a given version + CPU architecture. */
export function npkFileName(version: string, arch: string): string {
  const v = version.trim();
  const a = arch.trim();
  return majorOf(v) >= 7
    ? `routeros-${v}-${a}.npk`   // v7+: version before arch
    : `routeros-${a}-${v}.npk`;  // v6:  arch before version
}

/** Full download.mikrotik.com URL for the base bundle .npk. */
export function npkUrl(version: string, arch: string): string {
  return `${DOWNLOAD_BASE}/${version.trim()}/${npkFileName(version, arch)}`;
}

/** Extra (non-bundle) package .npk file name — v7 layout: <pkg>-<version>-<arch>.npk. */
export function extraPackageFileName(pkg: string, version: string, arch: string): string {
  return `${pkg.trim()}-${version.trim()}-${arch.trim()}.npk`;
}

// ─── Version comparison ───────────────────────────────────────────────────────
// Handles numeric segments (major.minor[.patch]) plus alpha/beta/rc pre-release
// suffixes attached to either the minor ("7.16beta4") or the patch ("7.15.3rc1").
// A final release ranks above any pre-release of the same numeric version.

interface ParsedVersion { nums: [number, number, number]; preRank: number; preNum: number; }

// alpha < beta < rc < final; final gets the highest rank so it sorts last.
const PRE_RANK: Record<string, number> = { alpha: 0, beta: 1, rc: 2 };
const FINAL_RANK = 3;

function parseRosVersion(version: string): ParsedVersion {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?(alpha|beta|rc)?(\d+)?$/.exec(version.trim().toLowerCase());
  if (!m) return { nums: [0, 0, 0], preRank: FINAL_RANK, preNum: 0 };
  return {
    nums: [parseInt(m[1], 10), parseInt(m[2], 10), m[3] ? parseInt(m[3], 10) : 0],
    preRank: m[4] ? PRE_RANK[m[4]] : FINAL_RANK,
    preNum: m[5] ? parseInt(m[5], 10) : 0,
  };
}

/** Compare two RouterOS versions. Returns -1 (a<b), 0 (equal), or 1 (a>b). */
export function compareRosVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseRosVersion(a);
  const pb = parseRosVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  if (pa.preRank !== pb.preRank) return pa.preRank > pb.preRank ? 1 : -1;
  if (pa.preNum !== pb.preNum) return pa.preNum > pb.preNum ? 1 : -1;
  return 0;
}

/** True when installing `target` over `installed` would move backwards. */
export function isDowngrade(target: string, installed: string): boolean {
  if (!installed || !installed.trim()) return false; // unknown installed version → not a downgrade
  return compareRosVersions(target, installed) < 0;
}

// ─── Extra-package guard ──────────────────────────────────────────────────────

export interface RouterOSPackage { name: string; version?: string; disabled: boolean; }

/**
 * Enabled packages that are NOT part of the base RouterOS bundle and would each
 * need their own .npk to move to `version`. On v7 the bundle is the single
 * 'routeros' package; on v6 the base is 'system' and everything else (wireless,
 * dhcp, …) ships separately. Any enabled non-base package is returned so the
 * orchestrator can refuse the rollout rather than silently break the device.
 */
export function extraEnabledPackages(packages: RouterOSPackage[], version: string): string[] {
  const base = majorOf(version) >= 7 ? new Set(['routeros']) : new Set(['system']);
  return packages
    .filter((p) => !p.disabled && p.name && !base.has(p.name.toLowerCase()))
    .map((p) => p.name);
}
