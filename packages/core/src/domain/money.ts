// Fixed-point money math for Stellar amounts.
// Stellar amounts have at most 7 decimal places ("stroops" = 1e-7).
// We never compare these as floats — we convert to integer stroops (BigInt).

export const STELLAR_DECIMALS = 7;

const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

export function isValidAmount(amount: string): boolean {
  return AMOUNT_RE.test(amount.trim());
}

/** Convert a decimal amount string ("12.3456789") to integer stroops (BigInt). */
export function toStroops(amount: string): bigint {
  const a = amount.trim();
  if (!AMOUNT_RE.test(a)) {
    throw new Error(`Invalid Stellar amount: "${amount}"`);
  }
  const [whole = "0", frac = ""] = a.split(".");
  const fracPadded = (frac + "0000000").slice(0, STELLAR_DECIMALS);
  return BigInt(whole) * 10_000_000n + BigInt(fracPadded || "0");
}

/** Normalize an amount string to a canonical 7-dp-trimmed form ("10.5", "10"). */
export function normalizeAmount(amount: string): string {
  const stroops = toStroops(amount);
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole}`;
}

export function fromStroops(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : `${whole}`;
}

export type AmountComparison = "exact" | "over" | "under";

/** Compare a received amount against an expected amount, in stroops. */
export function compareAmount(
  received: string,
  expected: string,
): AmountComparison {
  const r = toStroops(received);
  const e = toStroops(expected);
  if (r === e) return "exact";
  return r > e ? "over" : "under";
}
