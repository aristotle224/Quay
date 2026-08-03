import { describe, it, expect, beforeEach } from "vitest";

// A fixed 32-byte key so tests are deterministic and don't depend on the
// insecure dev-fallback warning path.
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "0".repeat(64);

const { encryptSecret, decryptSecret, last4, __resetKeyCacheForTests } = await import(
  "../src/services/secret-crypto"
);

beforeEach(() => {
  __resetKeyCacheForTests();
});

describe("secret-crypto", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const secret = "wh_sec_" + "a".repeat(48);
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it("produces different ciphertext for the same secret each time (random IV)", () => {
    const secret = "same-secret-value";
    const a = encryptSecret(secret);
    const b = encryptSecret(secret);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(secret);
    expect(decryptSecret(b)).toBe(secret);
  });

  it("rejects a malformed ciphertext", () => {
    expect(() => decryptSecret("not-a-valid-ciphertext")).toThrow(/Malformed/);
  });

  it("rejects ciphertext tampering (auth tag mismatch)", () => {
    const encrypted = encryptSecret("secret-value");
    const [iv, tag, data] = encrypted.split(".");
    const tamperedData = Buffer.from(data ?? "", "base64url");
    tamperedData[0] = (tamperedData[0] ?? 0) ^ 0xff;
    const tampered = [iv, tag, tamperedData.toString("base64url")].join(".");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("returns the last 4 characters for display", () => {
    expect(last4("0123456789abcdef")).toBe("cdef");
  });

  it("rejects an encryption key that is the wrong length", () => {
    __resetKeyCacheForTests();
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "0".repeat(64);
    __resetKeyCacheForTests();
  });
});
