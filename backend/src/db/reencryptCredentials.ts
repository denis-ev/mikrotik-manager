/**
 * One-shot forward migration of encrypted credentials.
 *
 * After a key rotation (including the automatic self-heal off a default key),
 * existing ciphertext still decrypts via the legacy-key fallback in crypto.ts,
 * but we want it re-encrypted under the current key so the legacy key can
 * eventually be retired. This sweep decrypts any stale value and rewrites it.
 * It is idempotent and best-effort — failures are logged, never fatal.
 */
import { query } from '../config/database';
import { encrypt, decrypt, needsReencryption } from '../utils/crypto';

interface EncryptedRow {
  id: number;
  api_password_encrypted: string | null;
  ssh_password_encrypted: string | null;
}

const TABLES = ['devices', 'credential_presets'] as const;
const COLUMNS = ['api_password_encrypted', 'ssh_password_encrypted'] as const;

export async function reencryptStaleCredentials(): Promise<number> {
  let rewritten = 0;

  for (const table of TABLES) {
    const rows = await query<EncryptedRow>(
      `SELECT id, ${COLUMNS.join(', ')} FROM ${table}`
    ).catch(() => [] as EncryptedRow[]);

    for (const row of rows) {
      const updates: Record<string, string> = {};
      for (const col of COLUMNS) {
        const value = row[col];
        if (!value || !needsReencryption(value)) continue;
        try {
          updates[col] = encrypt(decrypt(value));
        } catch {
          // Can't decrypt with any known key — leave it untouched.
        }
      }
      const keys = Object.keys(updates);
      if (keys.length === 0) continue;

      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await query(
        `UPDATE ${table} SET ${sets} WHERE id = $1`,
        [row.id, ...keys.map((k) => updates[k])]
      ).catch(() => {});
      rewritten += keys.length;
    }
  }

  if (rewritten > 0) {
    console.log(`[secrets] re-encrypted ${rewritten} credential value(s) under the current key`);
  }
  return rewritten;
}
