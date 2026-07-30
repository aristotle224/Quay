import { encodeMuxedAccount, encodeMuxedAccountToAddress, StrKey } from "@stellar/stellar-sdk";
import type { AssetRef, PaymentRequest, RailPort } from "@checkout/core";
import { buildSep7PayUri } from "@checkout/core";
import type { StellarConfig } from "./asset";

/** SEP-23: wraps a G-address and a 64-bit id into an M-address. The id is
 *  carried inside the destination itself, so it survives wallets that drop,
 *  mangle, or overwrite the memo — unlike MEMO_TEXT correlation. */
export function muxedFor(account: string, id: string): string {
  if (!StrKey.isValidEd25519PublicKey(account)) {
    throw new Error(`muxedFor: account must be a G-address, got "${account}"`);
  }
  return encodeMuxedAccountToAddress(encodeMuxedAccount(account, id));
}

/** Non-custodial settlement rail: the payer pays the seller's wallet directly.
 *
 *  Two correlation modes, chosen per-link by whether `muxedId` is supplied:
 *  - memo (default): the link reference is carried as MEMO_TEXT.
 *  - muxed: the link's 64-bit id is encoded into an SEP-23 M-address and no
 *    memo is set. Memo-mode requests are built exactly as before either way —
 *    the muxed path is additive, not a refactor of the existing one. */
export class StellarRail implements RailPort {
  constructor(private readonly cfg: StellarConfig) {}

  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    muxedId?: string | null;
    message?: string;
  }): PaymentRequest {
    const destination = input.muxedId ? muxedFor(input.destination, input.muxedId) : input.destination;
    const memo = input.muxedId ? undefined : input.reference;

    const uri = buildSep7PayUri({
      destination,
      amount: input.amount,
      asset: input.asset,
      memo,
      memoType: memo !== undefined ? "MEMO_TEXT" : undefined,
      message: input.message,
      networkPassphrase: this.cfg.networkPassphrase,
    });
    return {
      uri,
      destination,
      amount: input.amount,
      asset: input.asset,
      memo: memo ?? null,
    };
  }

  isValidDestination(address: string): boolean {
    return StrKey.isValidEd25519PublicKey(address);
  }
}
