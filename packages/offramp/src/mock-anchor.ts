import {
  OffRampJobNotFoundError,
  type AssetRef,
  type Logger,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampMode,
  type OffRampPort,
  type OffRampQuote,
  type IndicativePrice,
  type OffRampStateRepository,
  type SellerPayoutRef,
} from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

// ===========================================================================
//  MOCK ANCHOR — NOT A REAL OFF-RAMP.
// ===========================================================================
// This exists so the cash-out seam can be wired and demoed end-to-end before a
// licensed anchor relationship exists. It runs in `seller_initiated` mode:
// the seller already holds the stablecoin in their own wallet, and this just
// simulates quoting an FX rate and "paying out" local currency.
//
// To go live, replace this with an adapter that implements the same OffRampPort
// against a real Nigerian anchor's SEP endpoints:
//   quote()    -> SEP-38 POST /quote  (firm rate + expiry; moves in-flight FX risk)
//   initiate() -> SEP-24 interactive withdraw, or SEP-31 send  (start the payout)
//   status()   -> poll the transfer to settlement
//
// Do NOT promote this to `inline` mode without legal review: inline routing means
// value moves through the anchor mid-flight, which is the money-transmission /
// custody box. Keep custody at the edges until that story is real.
//
// Quotes and jobs are persisted through `OffRampStateRepository` rather than
// kept in a Map — this is money-adjacent state that must survive a restart,
// same as the real anchor adapter.

const ANCHOR_NAME = "mock";

const MOCK_RATES: Record<string, number> = {
  // 1 USDC -> X local units. Illustrative only.
  NGN: 1650,
  KES: 129,
  GHS: 15.5,
};

export interface MockAnchorOptions {
  state: OffRampStateRepository;
  /** ms before a quote expires (default 5 min). */
  quoteTtlMs?: number;
  /** ms after initiate() before the job flips to "settled" (default 8s, for demo). */
  settleAfterMs?: number;
  /** force every payout to fail, to exercise the retry path. */
  alwaysFail?: boolean;
  /** Optional logger; emits anchor.mock.* events. */
  logger?: Logger;
}

export class MockAnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly state: OffRampStateRepository;
  private readonly quoteTtlMs: number;
  private readonly settleAfterMs: number;
  private readonly alwaysFail: boolean;
  private readonly logger: Logger;

  constructor(opts: MockAnchorOptions) {
    this.state = opts.state;
    this.quoteTtlMs = opts.quoteTtlMs ?? 5 * 60_000;
    this.settleAfterMs = opts.settleAfterMs ?? 8_000;
    this.alwaysFail = opts.alwaysFail ?? false;
    this.logger = (opts.logger ?? NOOP_LOGGER).child({ component: "offramp.mock" });
  }

  /**
   * Indicative prices for all mock corridors — no network call, no quote burned
   * (issue 3.5). Mirrors the shape of SEP-38 GET /prices so the dashboard can
   * use the same path for both mock and testanchor modes.
   */
  async indicativePrices(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
  }): Promise<IndicativePrice[]> {
    // The mock doesn't vary rates by amount, but we accept the parameter so the
    // call-site is uniform with the real adapter.
    void input;
    return Object.entries(MOCK_RATES).map(([currency, rate]) => ({
      targetCurrency: currency,
      price: String(rate),
      deliveryMethods: ["BANK_TRANSFER"],
    }));
  }

  async quote(
    input: { linkId: string; sourceAsset: AssetRef; sourceAmount: string; targetCurrency: string },
    opts: { logger?: Logger } = {},
  ): Promise<OffRampQuote> {
    const log = opts.logger ?? this.logger;
    const rate = MOCK_RATES[input.targetCurrency];
    if (rate === undefined) {
      throw new Error(`Mock anchor has no rate for ${input.targetCurrency}`);
    }
    const targetAmount = (Number(input.sourceAmount) * rate).toFixed(2);
    const feeAmount = (Number(targetAmount) * 0.01).toFixed(2);
    const netTargetAmount = (Number(targetAmount) - Number(feeAmount)).toFixed(2);

    const quoteId = id("quote");
    const now = Date.now();
    const expiresAt = now + this.quoteTtlMs;

    await this.state.saveQuote({
      quoteId,
      linkId: input.linkId,
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: String(rate),
      expiresAt,
      createdAt: now,
    });

    log.info({ event: "anchor.mock.quote", quoteId, targetCurrency: input.targetCurrency, targetAmount }, "mock quote");
    return {
      quoteId,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount,
      rate: String(rate),
      expiresAt,
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "estimated" },
      netTargetAmount,
    };
  }

  async initiate(
    input: { linkId: string; quoteId: string; payout: SellerPayoutRef },
    opts: { logger?: Logger } = {},
  ): Promise<OffRampInitiation> {
    const log = opts.logger ?? this.logger;
    const q = await this.state.getQuote(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");
    if (Date.now() > q.expiresAt) throw new Error("Quote expired");

    const grossAmount = (Number(q.sellAmount) * Number(q.price)).toFixed(2);
    const feeAmount = (Number(grossAmount) * 0.01).toFixed(2);
    const targetAmount = (Number(grossAmount) - Number(feeAmount)).toFixed(2);
    const jobId = id("ofr");
    const now = Date.now();

    await this.state.saveJob({
      jobId,
      linkId: input.linkId,
      anchor: ANCHOR_NAME,
      targetCurrency: q.buyCurrency,
      targetAmount,
      rate: q.price,
      status: "pending",
      externalStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });

    log.info({ event: "anchor.mock.initiate", jobId, linkId: input.linkId }, "mock initiate");
    return { kind: "fields", jobId };
  }

  async status(jobId: string, opts: { logger?: Logger } = {}): Promise<OffRampJob> {
    const log = opts.logger ?? this.logger;
    const job = await this.state.getJob(jobId);
    if (!job) throw new OffRampJobNotFoundError(jobId);

    let status = job.status;
    let lastError = job.lastError;
    if (status === "pending" && Date.now() - job.createdAt >= this.settleAfterMs) {
      status = this.alwaysFail ? "failed" : "settled";
      lastError = status === "failed" ? "mock anchor: simulated payout failure" : null;
      await this.state.updateJob(jobId, { status, lastError });
      log.info({ event: "anchor.mock.status.transition", jobId, status }, "mock status transition");
    }

    return {
      jobId,
      linkId: job.linkId,
      status,
      targetCurrency: job.targetCurrency,
      targetAmount: job.targetAmount,
      rate: job.rate,
      reason: lastError ?? undefined,
    };
  }
}

function id(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}
