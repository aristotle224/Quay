import type { AssetRef, PaymentLink } from "../domain/payment-link";
import type { NormalizedPayment } from "../matching/match-payment";

// ---------------------------------------------------------------------------
// Settlement rail port
// ---------------------------------------------------------------------------
// Builds the payer-facing payment request. The Stellar adapter implements this
// with SEP-7; a different chain would implement it differently — the domain
// never sees chain-specific types.

export interface PaymentRequest {
  uri: string; // e.g. a SEP-7 web+stellar:pay URI
  destination: string;
  amount: string;
  asset: AssetRef;
  memo: string; // correlation reference echoed back on-chain
}

export interface RailPort {
  /** Build a payment request a wallet can fulfill. */
  buildRequest(input: {
    destination: string;
    amount: string;
    asset: AssetRef;
    reference: string;
    message?: string;
  }): PaymentRequest;

  /** Validate that a string is a usable destination address for this rail. */
  isValidDestination(address: string): boolean;
}

// ---------------------------------------------------------------------------
// Settlement watcher port
// ---------------------------------------------------------------------------
// Pulls new incoming payments for an account since a cursor. Polling keeps the
// MVP restart-safe and simple; a streaming impl can satisfy the same port.

export interface WatcherPort {
  /** Most-recent paging token for an account, used to seed a fresh watch. */
  latestCursor(account: string): Promise<string | null>;

  /** Incoming payments to `account` strictly after `cursor`, oldest-first. */
  fetchSince(account: string, cursor: string, limit?: number): Promise<NormalizedPayment[]>;
}

// ---------------------------------------------------------------------------
// Off-ramp port  ← the seam this whole product is built around
// ---------------------------------------------------------------------------
// `seller_initiated`: the seller receives the stablecoin to their own wallet and
//   later triggers a cash-out. Custody stays at the edges. This is the MVP mode.
// `inline`: value is routed through the anchor mid-flight so the seller receives
//   local currency directly. This is what merchants want — and it is the mode that
//   puts you in the money-transmission / custody bucket. Do not enable it until a
//   licensed anchor relationship and a compliance story are real.
//
// Interface shape mirrors the Stellar SEP standards you'd wire underneath:
//   quote()    ~ SEP-38 (firm FX quote with an expiry; transfers in-flight rate risk)
//   initiate() ~ SEP-24 / SEP-31 (start a withdrawal/payout to local rails)
//   status()   ~ poll the transfer to settlement

export type OffRampMode = "seller_initiated" | "inline";

export interface OffRampQuote {
  quoteId: string;
  sourceAsset: AssetRef;
  sourceAmount: string;
  targetCurrency: string; // ISO code, e.g. "NGN"
  targetAmount: string; // what the seller will receive
  rate: string; // sourceAsset -> targetCurrency
  expiresAt: number; // epoch ms — after this the quote is void
}

/** Where the seller wants their local-currency payout to land. */
export interface SellerPayoutRef {
  currency: string; // "NGN"
  // Opaque to the domain; an anchor adapter interprets these (bank/account, etc.).
  fields: Record<string, string>;
}

export type OffRampJobStatus = "pending" | "settled" | "failed";

export interface OffRampJob {
  jobId: string;
  linkId: string;
  status: OffRampJobStatus;
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  reason?: string; // set when failed
}

export interface OffRampPort {
  readonly mode: OffRampMode;
  quote(input: { sourceAsset: AssetRef; sourceAmount: string; targetCurrency: string }): Promise<OffRampQuote>;
  initiate(input: { linkId: string; quoteId: string; payout: SellerPayoutRef }): Promise<OffRampJob>;
  status(jobId: string): Promise<OffRampJob>;
}

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface CreateLinkInput {
  id: string;
  reference: string;
  sellerId: string;
  destination: string;
  title: string;
  amount: string;
  asset: AssetRef;
  expiresAt: number | null;
  /** When true this row was created by the demo seed script. */
  isDemo?: boolean;
}

export interface LinkRepository {
  create(input: CreateLinkInput): Promise<PaymentLink>;
  findById(id: string): Promise<PaymentLink | null>;
  findByReference(reference: string): Promise<PaymentLink | null>;
  listBySeller(sellerId: string): Promise<PaymentLink[]>;
  /** All links currently in a given status (used by the cash-out poller). */
  listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]>;
  /** Distinct destination addresses that currently have at least one active link. */
  activeDestinations(): Promise<string[]>;
  /** Active (or underpaid) links whose value lands in `destination`. */
  openLinksForDestination(destination: string): Promise<PaymentLink[]>;
  save(link: PaymentLink): Promise<void>;
}

export interface Seller {
  id: string;
  name: string;
  wallet: string;
  createdAt: number;
}

export interface SellerRepository {
  getDefault(): Promise<Seller>;
  findById(id: string): Promise<Seller | null>;
}

export interface Webhook {
  id: string;
  sellerId: string;
  url: string;
  secret: string;
  createdAt: number;
}

export interface WebhookDelivery {
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
}

export interface WebhookRepository {
  create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook>;
  listBySeller(sellerId: string): Promise<Webhook[]>;
  recordDelivery(d: WebhookDelivery): Promise<void>;
}

/** Watcher bookkeeping: per-account cursor + processed-tx ledger for idempotency. */
export interface WatcherStateRepository {
  getCursor(account: string): Promise<string | null>;
  setCursor(account: string, cursor: string): Promise<void>;
  isProcessed(txHash: string): Promise<boolean>;
  markProcessed(txHash: string, linkId: string | null): Promise<void>;
}
