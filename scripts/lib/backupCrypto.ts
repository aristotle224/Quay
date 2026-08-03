import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES-256-GCM at-rest encryption for backup dumps (issue 8.6 - "encrypt
 * backups at rest; never store KYC fields unencrypted in a dump"). Rather
 * than track which columns are KYC fields (fragile, and the schema has no
 * KYC columns yet - see issue 3.4), the entire dump is encrypted as one
 * blob, so no field of any kind is ever written to disk in the clear.
 *
 * Wire format: `[iv(12 bytes)][authTag(16 bytes)][ciphertext]`.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export function requireBackupEncryptionKey(): Buffer {
  const hex = process.env.BACKUP_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY is required - backups are never written unencrypted. " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      `BACKUP_ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM; ` +
        `got ${key.length} bytes after decoding.`,
    );
  }
  return key;
}

export function encryptBackupPayload(payload: unknown, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptBackupPayload<T = unknown>(blob: Buffer, key: Buffer): T {
  if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Backup file is too short to contain a valid iv + authTag + ciphertext.");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
