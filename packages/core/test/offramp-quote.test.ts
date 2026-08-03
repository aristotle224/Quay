import { describe, it, expect } from "vitest";
import { isQuoteExpired, QuoteExpiredError } from "../src/ports/index";
import type { OffRampQuote } from "../src/ports/index";
import type { AssetRef } from "../src/domain/payment-link";

const USDC: AssetRef = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

function makeQuote(expiresAt: number): OffRampQuote {
  return {
    quoteId: "q_test",
    sourceAsset: USDC,
    sourceAmount: "10",
    targetCurrency: "NGN",
    targetAmount: "16500",
    rate: "1650",
    expiresAt,
  };
}

const NOW = 1_700_000_000_000; // fixed reference epoch ms

describe("isQuoteExpired", () => {
  it("returns false for a quote that expires in the future", () => {
    const quote = makeQuote(NOW + 60_000);
    expect(isQuoteExpired(quote, NOW)).toBe(false);
  });

  it("returns true for a quote whose expiresAt is in the past", () => {
    const quote = makeQuote(NOW - 1);
    expect(isQuoteExpired(quote, NOW)).toBe(true);
  });

  it("returns true when expiresAt exactly equals now (boundary — treat as expired)", () => {
    const quote = makeQuote(NOW);
    expect(isQuoteExpired(quote, NOW)).toBe(true);
  });

  it("returns true when expiresAt is NaN (unparsable anchor response)", () => {
    const quote = makeQuote(NaN);
    expect(isQuoteExpired(quote, NOW)).toBe(true);
  });

  it("returns true when expiresAt is 0 (zero epoch — effectively expired)", () => {
    const quote = makeQuote(0);
    expect(isQuoteExpired(quote, NOW)).toBe(true);
  });

  it("uses Date.now() when no explicit 'now' is passed", () => {
    // A quote expiring 10 years from now should never be expired.
    const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(isQuoteExpired(makeQuote(farFuture))).toBe(false);
  });
});

describe("QuoteExpiredError", () => {
  it("is an instance of Error", () => {
    const err = new QuoteExpiredError("q_abc");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries the quoteId", () => {
    const err = new QuoteExpiredError("q_abc");
    expect(err.quoteId).toBe("q_abc");
  });

  it("has a descriptive message", () => {
    const err = new QuoteExpiredError("q_abc");
    expect(err.message).toMatch(/q_abc/);
  });

  it("has name QuoteExpiredError", () => {
    expect(new QuoteExpiredError("x").name).toBe("QuoteExpiredError");
  });
});
