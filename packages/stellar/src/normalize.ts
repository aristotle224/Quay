import type { Horizon } from "@stellar/stellar-sdk";
import type { AssetRef, NormalizedPayment } from "@checkout/core";

// Operation types that move value to a recipient and carry a destination asset/amount.
const VALUE_TYPES = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

type AnyRecord = Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.OperationRecord;

interface ValueFields {
  to?: string;
  from?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  // Present when the operation's destination was specified as an SEP-23
  // M-address; Horizon still normalizes `to` to the underlying G-address.
  to_muxed_id?: string;
}

export function isValuePayment(record: AnyRecord): boolean {
  return VALUE_TYPES.has(record.type);
}

function assetOf(r: ValueFields): AssetRef {
  if (r.asset_type === "native" || r.asset_type === undefined) {
    return { code: "XLM", issuer: null };
  }
  return { code: r.asset_code ?? "", issuer: r.asset_issuer ?? null };
}

/**
 * Convert a raw Horizon record into a NormalizedPayment.
 * The memo lives on the *transaction*, not the operation, so we fetch it.
 * Returns null for non-value operations (e.g. create_account).
 */
export async function normalizePayment(record: AnyRecord): Promise<NormalizedPayment | null> {
  if (!isValuePayment(record)) return null;
  const r = record as unknown as ValueFields & {
    transaction_hash: string;
    paging_token: string;
    created_at: string;
    transaction: () => Promise<Horizon.ServerApi.TransactionRecord>;
  };

  let memo: string | null = null;
  let memoType: string | null = null;
  try {
    const tx = await r.transaction();
    memoType = tx.memo_type ?? null;
    memo = memoType && memoType !== "none" ? (tx.memo ?? null) : null;
  } catch {
    // If the tx can't be fetched, treat as no-memo; the matcher will park it.
    memo = null;
    memoType = null;
  }

  return {
    txHash: r.transaction_hash,
    pagingToken: r.paging_token,
    from: r.from ?? "",
    to: r.to ?? "",
    amount: r.amount ?? "0",
    asset: assetOf(r),
    memo,
    memoType,
    toMuxedId: r.to_muxed_id ?? null,
    createdAt: r.created_at,
  };
}
