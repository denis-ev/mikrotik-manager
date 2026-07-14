/**
 * AES-256-GCM helpers for encrypting device credentials at rest in PostgreSQL.
 *
 * Key material: set `ENCRYPTION_KEY` in the environment (see README). If unset,
 * a development-only default is used — production deployments must set a
 * strong secret. Key rotation / recovery is documented under README
 * "Credential encryption (ENCRYPTION_KEY)".
 */
import * as crypto from 'crypto';
import { encryptionKey, decryptionKeys } from './secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

export function encrypt(text: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv:tag:encrypted (all hex)
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptWith(key: Buffer, iv: Buffer, tag: Buffer, encrypted: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const encrypted = Buffer.from(parts[2], 'hex');

  // Try the current key first, then every legacy key, so ciphertext written
  // under an older (or default) key keeps decrypting after a key rotation.
  let lastErr: unknown;
  for (const key of decryptionKeys()) {
    try {
      return decryptWith(key, iv, tag, encrypted);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Unable to decrypt');
}

/**
 * True if the ciphertext does NOT decrypt under the current key (i.e. it was
 * written with a legacy key and should be re-encrypted forward).
 */
export function needsReencryption(encryptedText: string): boolean {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) return false;
  try {
    decryptWith(encryptionKey(), Buffer.from(parts[0], 'hex'), Buffer.from(parts[1], 'hex'), Buffer.from(parts[2], 'hex'));
    return false;
  } catch {
    return true;
  }
}
