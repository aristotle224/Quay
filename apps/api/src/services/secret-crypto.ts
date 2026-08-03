import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encrypts webhook signing secrets at rest.
 *
 * This is deliberately *reversible* (AES-256-GCM), not a one-way hash: the
 * platform signs every outgoing delivery with HMAC-SHA256 using the raw
 * secret (see webhook-sender.ts), so it must be able to recover the
 * plaintext. A one-way hash (as used for e.g. password storage) would make
 * that impossible — the secret can only ever be *hashed for comparison*,
 * never *used to sign*.
 *
 * What this protects against: a database read (backup leak, SQL injection,
 * compromised replica) does not hand the attacker live signing secrets. The
 * plaintext is only ever reconstructed in-process, at the moment a delivery
 * is signed, and is never returned by any read endpoint — API routes only
 * ever return the plaintext once, directly from `create` / `rotate-secret`,
 * before this module ever sees it stored.
 *
 * Ciphertext format: `<iv:12b b64url>.<authTag:16b b64url>.<ciphertext b64url>`
 */

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey: Buffer | null = null;

function resolveKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error(
        "WEBHOOK_SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars, or base64 of 32 bytes).",
      );
    }
    cachedKey = key;
    return key;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "WEBHOOK_SECRET_ENCRYPTION_KEY is required in production (webhook secrets are encrypted at rest with it).",
    );
  }

  // Dev/test fallback: deterministic, NOT secret, so local restarts and test
  // runs stay consistent without requiring setup. Never used in production
  // (guarded above).
  console.warn(
    "[webhook-crypto] WEBHOOK_SECRET_ENCRYPTION_KEY not set — using an insecure, deterministic dev key. " +
      "Set WEBHOOK_SECRET_ENCRYPTION_KEY before deploying.",
  );
  cachedKey = scryptSync("dev-only-insecure-key", "quay-webhook-secrets", 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(encoded: string): string {
  const [ivB64, tagB64, dataB64] = encoded.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted webhook secret.");
  }
  const key = resolveKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Display-only last 4 characters — never sensitive enough to need encryption. */
export function last4(secret: string): string {
  return secret.slice(-4);
}

/** Test-only: allows tests to reset the cached key between runs. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
