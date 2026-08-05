import type { LinkStatus } from "./status";

/** A reference to a Stellar asset. `null` issuer means native XLM. */
export interface AssetRef {
  code: string; // "USDC" or "XLM"
  issuer: string | null; // G... issuer, or null for native
}

export const XLM: AssetRef = { code: "XLM", issuer: null };

export function isNative(asset: AssetRef): boolean {
  return asset.issuer === null;
}

export function assetEquals(a: AssetRef, b: AssetRef): boolean {
  if (isNative(a) || isNative(b)) {
    return isNative(a) && isNative(b) && a.code === b.code;
  }
  return a.code === b.code && a.issuer === b.issuer;
}

export interface PaymentLink {
  id: string; // public id, used in the checkout URL (/pay/:id)
  reference: string; // short, <=28 bytes — embedded as the Stellar MEMO_TEXT
  sellerId: string;
  destination: string; // seller's G-address (payments land here, non-custodial)
  // SEP-23 muxed id embedded in the M-address handed to the payer when
  // CORRELATION=muxed. Null in memo mode (the default) — the two correlation
  // paths are independent, and a link only ever uses one.
  muxedId: string | null;
  title: string;
  amount: string; // requested amount, canonical decimal string
  asset: AssetRef;
  status: LinkStatus;
  // settlement (filled when paid)
  txHash: string | null;
  payer: string | null;
  paidAmount: string | null;
  overpaidAmount: string | null;
  // off-ramp (filled when the seller cashes out)
  offrampJobId: string | null;
  offrampTargetCurrency: string | null;
  offrampStatus: string | null;
  /**
   * Indicative rate shown to the seller before they committed (issue 3.5).
   * Stored at the moment the seller opens the cash-out form (GET offramp-preview).
   * The delta with `offrampRate` is the anchor's real spread.
   */
  offrampIndicativeRate: string | null;
  /**
   * The firm rate from the SEP-38 POST /quote used to initiate this cash-out.
   * Stored by triggerCashOut() (issue 3.5).
   */
  offrampRate: string | null;
  /**
   * Absolute difference between the indicative and firm rates (firm − indicative),
   * as a decimal string. Persisted so the spread is queryable without recomputing
   * (issue 3.5 / 3.8 telemetry).
   */
  offrampRateDelta: string | null;
  /**
   * Anchor fee quoted at the moment cash-out was initiated (issue 1.5), so a
   * receipt can reproduce gross/fee/net without recomputing against a rate
   * that may have moved since. `offrampFeeSource` is "anchor" when the anchor
   * itself reported it (SEP-38 total_price), "estimated" for the mock adapter.
   */
  offrampFeeAmount: string | null;
  offrampFeeCurrency: string | null;
  offrampFeeSource: string | null;
  offrampNetTargetAmount: string | null;
  expiresAt: number | null; // epoch ms
  /** True for rows created by the demo seed script. Displayed as a badge in the UI. */
  isDemo: boolean;
  createdAt: number;
  updatedAt: number;
}
