import { createHash, randomBytes } from 'crypto';

// Fleet-managed RouterOS scripts/schedulers are tracked by a stable marker token
// written into the device's comment field. The marker is the ONLY link between a
// fleet-level "managed script" and its copies on individual devices, so it must
// survive round-trips through the RouterOS comment field and coexist with any
// human-authored comment text the operator already put there.
//
// Format: `MTM:<8 hex>` (e.g. `MTM:1a2f9c04`). We only ever write it on explicit
// user actions (adopt / link / push), never during passive inventory polling.

const MARKER_RE = /\bMTM:([0-9a-f]{8})\b/i;

/** Generate a fresh 8-hex-char marker id from cryptographically random bytes. */
export function generateMarkerId(): string {
  return randomBytes(4).toString('hex');
}

/** Extract the marker id from a comment, or null if none present. Case-insensitive. */
export function parseMarker(comment: string | null | undefined): string | null {
  if (!comment) return null;
  const m = comment.match(MARKER_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Remove the marker token (and any whitespace it introduced) from a comment,
 * returning the operator's own text trimmed. Safe to call on comments with no
 * marker — returns the original text trimmed.
 */
export function stripMarker(comment: string | null | undefined): string {
  if (!comment) return '';
  return comment
    .replace(MARKER_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Append (or replace) the marker on a comment while preserving the operator's own
 * text. A single space separates existing text from the marker. If the comment
 * already carried a (possibly different) marker, it is replaced, not duplicated.
 */
export function appendMarker(comment: string | null | undefined, id: string): string {
  const base = stripMarker(comment);
  const marker = `MTM:${id.toLowerCase()}`;
  return base ? `${base} ${marker}` : marker;
}

/**
 * Normalise a script/scheduler source so semantically-identical content across
 * devices hashes the same: CRLF/CR → LF, trailing whitespace stripped per line,
 * trailing blank lines removed.
 */
export function normalizeSource(source: string | null | undefined): string {
  if (!source) return '';
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** sha256 hex of the normalized source. Stable content fingerprint for grouping. */
export function hashSource(source: string | null | undefined): string {
  return createHash('sha256').update(normalizeSource(source)).digest('hex');
}
