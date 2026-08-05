import {
  CannotReceiveError,
  canTransition,
  isQuoteExpired,
  QuoteExpiredError,
  normalizeAmount,
  OffRampJobNotFoundError,
  NOOP_LOGGER,
  type CashOutBody,
  type CreateLinkBody,
  type KycPort,
  type LinkRepository,
  type Logger,
  type MatchOutcome,
  type NormalizedPayment,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampQuote,
  type OffRampPort,
  type OffRampStateRepository,
  type PaymentLink,
  type PaymentRequest,
  type RailPort,
  type SellerRepository,
  type WebhookRepository,
  type IndicativePrice,
} from "@checkout/core";
import { canReceiveAsset, resolveAsset, type StellarConfig } from "@checkout/stellar";
import { newId, newMuxedId, newReference } from "./ids";
import { WebhookSender } from "./webhook-sender";
import { metrics } from "../metrics";

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

/** Per-call logger override — omit to fall back to the service's own ambient logger. */
export interface ServiceCallOptions {
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// AnchorHealth — background probe + circuit breaker (issue #19, 3.7).
// ---------------------------------------------------------------------------
// A live `AnchorHealth` distinguishes a dead anchor from a slow one. A
// background timer pings TOML + SEP-10 + /info every `intervalMs`. After
// `failureThreshold` consecutive failures the breaker opens; while open,
// `triggerCashOut` fails fast with 503 "anchor_unavailable" instead of
// hammering a dead endpoint. After `cooldownMs` the breaker transitions to
// `half_open` and the very next probe decides whether we go back to `closed`
// (success) or stay `open` (another failure).

export type CircuitState = "closed" | "open" | "half_open";

export interface AnchorHealthSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  url: string | null;
  probes: { toml: boolean; sep10: boolean; info: boolean };
}

export interface AnchorProbeConfig {
  /** When false (mock mode), `probe()` short-circuits to a success without any network IO. */
  enabled: boolean;
  /** Anchor base URL (e.g. https://testanchor.stellar.org). */
  url: string | null;
  /** Home domain used for TOML and SEP-10. */
  homeDomain: string | null;
  /** Defaults to 3. */
  failureThreshold?: number;
  /** Defaults to 30_000 ms. */
  cooldownMs?: number;
  /** Defaults to 5_000 ms per individual probe HTTP call. */
  requestTimeoutMs?: number;
}

export class AnchorHealth {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastCheckedAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private probes = { toml: false, sep10: false, info: false };

  private readonly enabled: boolean;
  private readonly url: string | null;
  private readonly homeDomain: string | null;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly requestTimeoutMs: number;

  constructor(cfg: AnchorProbeConfig) {
    this.enabled = cfg.enabled;
    this.url = cfg.url;
    this.homeDomain = cfg.homeDomain;
    this.failureThreshold = cfg.failureThreshold ?? 3;
    this.cooldownMs = cfg.cooldownMs ?? 30_000;
    this.requestTimeoutMs = cfg.requestTimeoutMs ?? 5_000;
  }

  /**
   * Snapshot of the current breaker state. The returned `state` reflects the
   * promotion (open → half_open on cooldown expiry) — see `tickState` for the
   * explicit time-advance mutation this triggers.
   */
  snapshot(): AnchorHealthSnapshot {
    this.tickState();
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.lastCheckedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      url: this.url,
      probes: { ...this.probes },
    };
  }

  /**
   * `true` when cash-out traffic is allowed. `closed` and `half_open` are both
   * "try it"; only `open` (within the cooldown window) blocks traffic. This
   * method mutates the stored state on cooldown expiry so callers always see
   * the most recent decision; the side-effect is explicit in `tickState`.
   */
  isAvailable(): boolean {
    this.tickState();
    return this.state !== "open";
  }

  /**
   * Time-based advance of the breaker. Promotes `open → half_open` once the
   * cooldown has elapsed, so the next probe becomes a "trial shot". Exposed as
   * a public helper so callers can be explicit about the mutation if they
   * want to; we still call it from getters in this file because that's the
   * sanest policy for snap/decide ergonomics.
   */
  tickState(): void {
    if (
      this.state === "open" &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.cooldownMs
    ) {
      this.state = "half_open";
    }
  }

  /** Run one probe cycle: TOML → SEP-10 challenge → /info. */
  async probe(): Promise<AnchorHealthSnapshot> {
    if (!this.enabled || !this.url || !this.homeDomain) {
      // Mock mode or unconfigured: short-circuit to a healthy state without IO.
      this.tickState();
      this.recordSuccess();
      return this.snapshot();
    }
    // Time-advance before we measure: if the cooldown just elapsed, we want
    // this probe to count as the half-open trial shot rather than get blocked
    // by an out-of-date "open" state.
    this.tickState();
    this.lastCheckedAt = Date.now();
    const probes = { toml: false, sep10: false, info: false };
    try {
      // 1. TOML reachable.
      const tomlUrl = `https://${this.homeDomain}/.well-known/stellar.toml`;
      const tomlRes = await fetchWithTimeout(tomlUrl, this.requestTimeoutMs);
      probes.toml = tomlRes.ok;
      if (!tomlRes.ok) throw new Error(`TOML probe returned ${tomlRes.status}`);

      // 2. SEP-10 challenge obtainable (no signing — this is a liveness check).
      const sep10Url = new URL("/auth", this.url);
      sep10Url.searchParams.set("account", "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK5KQ");
      sep10Url.searchParams.set("home_domain", this.homeDomain);
      const sep10Res = await fetchWithTimeout(sep10Url.toString(), this.requestTimeoutMs);
      probes.sep10 = sep10Res.ok;
      if (!sep10Res.ok) throw new Error(`SEP-10 challenge returned ${sep10Res.status}`);
      const sep10Body = (await sep10Res.json()) as { transaction?: string };
      if (!sep10Body.transaction) throw new Error("SEP-10 challenge missing transaction");

      // 3. /info 200.
      const infoUrl = new URL("/info", this.url);
      const infoRes = await fetchWithTimeout(infoUrl.toString(), this.requestTimeoutMs);
      probes.info = infoRes.ok;
      if (!infoRes.ok) throw new Error(`/info returned ${infoRes.status}`);

      this.probes = probes;
      this.recordSuccess();
    } catch (err) {
      this.probes = probes;
      this.recordFailure(err);
    }
    return this.snapshot();
  }

  private recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
  }

  private recordFailure(err: unknown): void {
    this.consecutiveFailures++;
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

export class LinkService {
  private readonly sender: WebhookSender;
  // Ephemeral: cash-out start time for the quote-to-settlement histogram. A
  // process restart mid-cash-out just loses that one latency sample — the
  // link's own status/offrampStatus fields remain the durable source of truth.
  private readonly cashOutStartedAt = new Map<string, number>();
  private readonly health: AnchorHealth;
  /** Per-link last poll error (in-memory; survives only until restart). */
  private readonly lastPollErrorByLinkId = new Map<string, string>();
  /**
   * Per-link next-attempt-allowed timestamp. After a status() failure we
   * exponentially back off per job so a downed anchor isn't hammered by the
   * every-interval loop hitting the same failing job id over and over.
   * In-memory only — a follow-up PR adds `next_try_at` to the schema so this
   * survives restart.
   */
  private readonly nextPollAtByLinkId = new Map<string, number>();
  private static readonly POLL_BACKOFF_BASE_MS = 2_000;
  private static readonly POLL_BACKOFF_CAP_MS = 60_000;
  private readonly consecutivePollErrorsByLinkId = new Map<string, number>();

  constructor(
    private readonly deps: {
      links: LinkRepository;
      sellers: SellerRepository;
      webhooks: WebhookRepository;
      rail: RailPort;
      offramp: OffRampPort;
      offrampState: OffRampStateRepository;
      kyc: KycPort;
      stellar: StellarConfig;
      /**
       * Optional anchor health probe. When omitted we default to a no-op
       * "always available" probe so existing test fixtures stay lightweight.
       */
      health?: AnchorHealth;
      // "memo" (default) or "muxed" — see packages/stellar/src/stellar-rail.ts.
      correlation: "memo" | "muxed";
      /** Optional SSRF guard override, threaded into WebhookSender. Tests inject
       *  a permissive one so they do not depend on live DNS resolution. */
      webhookGuard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
      /** Ambient logger, used whenever a call site doesn't pass its own via ServiceCallOptions. */
      logger?: Logger;
    },
  ) {
    this.deps.logger = this.deps.logger ?? NOOP_LOGGER;
    this.sender = new WebhookSender(deps.webhooks, { guard: deps.webhookGuard, logger: this.deps.logger });
    this.health =
      deps.health ?? new AnchorHealth({ enabled: false, url: null, homeDomain: null });
  }

  /** Webhook deliveries currently in flight (including in-process retries). */
  webhookQueueDepth(): number {
    return this.sender.inFlightCount;
  }

  private buildRequest(link: PaymentLink): PaymentRequest {
    return this.deps.rail.buildRequest({
      destination: link.destination,
      amount: link.amount,
      asset: link.asset,
      reference: link.reference,
      muxedId: link.muxedId,
      message: link.title,
    });
  }

  async createLink(sellerId: string, body: CreateLinkBody, opts: ServiceCallOptions = {}): Promise<LinkWithRequest> {
    const log = opts.logger ?? this.deps.logger!;
    const seller = await this.deps.sellers.findById(sellerId);
    if (!seller) throw new HttpError(404, "seller_not_found");
    const asset = resolveAsset(body.assetCode, this.deps.stellar);
    const expiresAt = body.expiresInMinutes
      ? Date.now() + body.expiresInMinutes * 60_000
      : null;

    // Universal receive-preflight (issue #9): every link, not just muxed ones.
    // Subsumes the muxed-only `canReceiveAsset` check that used to live in the
    // branch below — this runs first and carries the richer 422 payload.
    try {
      await this.deps.rail.assertCanReceive(seller.wallet, asset);
    } catch (err) {
      if (err instanceof CannotReceiveError) {
        throw new HttpError(422, "destination_cannot_receive", {
          message: err.message,
          reason: err.reason,
          asset,
          ...(err.trustlineUri ? { trustlineUri: err.trustlineUri } : {}),
        });
      }
      throw err;
    }

    let muxedId: string | null = null;
    if (this.deps.correlation === "muxed") {
      muxedId = newMuxedId();
    }

    const link = await this.deps.links.create({
      id: newId("lnk"),
      reference: newReference(),
      sellerId: seller.id,
      destination: seller.wallet,
      muxedId,
      title: body.title,
      amount: normalizeAmount(body.amount),
      asset,
      expiresAt,
      isDemo: body.isDemo ?? false,
    });
    metrics.linkStatusTransitionsTotal.inc({ to: link.status });

    log.info(
      {
        event: "link.created",
        linkId: link.id,
        reference: link.reference,
        sellerId: link.sellerId,
        destination: link.destination,
        amount: link.amount,
        assetCode: link.asset.code,
        assetIssuer: link.asset.issuer,
        expiresAt: link.expiresAt,
      },
      "link created",
    );

    return { link, request: this.buildRequest(link) };
  }

  /** Re-checks the seller's own USDC trustline (bypassing the preflight cache is
   *  unnecessary — a 60s-stale "ok" or "revoked" is fine for a health check). */
  async checkSellerUsdcTrustline(): Promise<
    { ok: true } | { ok: false; reason: string; message: string; trustlineUri?: string }
  > {
    const seller = await this.deps.sellers.getDefault();
    const asset = resolveAsset("USDC", this.deps.stellar);
    try {
      await this.deps.rail.assertCanReceive(seller.wallet, asset);
      return { ok: true };
    } catch (err) {
      if (err instanceof CannotReceiveError) {
        return { ok: false, reason: err.reason, message: err.message, trustlineUri: err.trustlineUri };
      }
      throw err;
    }
  }

  async listLinks(sellerId: string): Promise<PaymentLink[]> {
    return this.deps.links.listBySeller(sellerId);
  }

  async getLink(id: string, _opts: ServiceCallOptions = {}): Promise<LinkWithRequest | null> {
    const link = await this.deps.links.findById(id);
    if (!link) return null;
    return { link, request: this.buildRequest(link) };
  }

  /**
   * Return indicative FX rates for a paid link — SEP-38 GET /prices, no quote
   * consumed (issue 3.5). The response is clearly labelled indicative so the
   * dashboard can show it without burning a firm quote on every page visit.
   *
   * Side effect: persists the indicative rate for the requested `targetCurrency`
   * against the link so `triggerCashOut` can later compute the spread delta.
   *
   * Returns null when the adapter does not implement `indicativePrices` (e.g.
   * a future adapter that can only provide firm quotes).
   */
  async getOfframpPreview(
    linkId: string,
    targetCurrency?: string,
  ): Promise<{ indicative: true; prices: IndicativePrice[]; sourceAmount: string } | null> {
    const link = await this.deps.links.findById(linkId);
    if (!link) throw new HttpError(404, "Link not found");
    if (link.status !== "paid") {
      throw new HttpError(409, `Link must be paid to preview off-ramp (is "${link.status}")`);
    }
    if (!this.deps.offramp.indicativePrices) return null;

    const sourceAmount = link.paidAmount ?? link.amount;
    let prices: IndicativePrice[];
    try {
      prices = await this.deps.offramp.indicativePrices({
        sourceAsset: link.asset,
        sourceAmount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Off-ramp preview error: ${message}`);
    }

    // Persist the indicative rate for the target currency so triggerCashOut()
    // can compute the indicative-vs-firm delta (issue 3.5 telemetry).
    const currency = targetCurrency ?? link.offrampTargetCurrency;
    if (currency) {
      const match = prices.find((p) => p.targetCurrency === currency);
      if (match && link.offrampIndicativeRate !== match.price) {
        link.offrampIndicativeRate = match.price;
        await this.deps.links.save(link);
      }
    }

    return { indicative: true, prices, sourceAmount };
  }

  /**
   * Apply a matched payment to its link. Returns whether the link advanced to
   * `paid` (so the watcher can decide what to log). Idempotency of the *payment*
   * (processed-tx ledger) is the caller's responsibility; here we additionally
   * guard the domain transition so a duplicate can never double-apply.
   *
   * The watcher emits one `payment.matched` line for every payment it inspects
   * (paid/underpaid/no_memo/unknown_reference/asset_mismatch). Here we ONLY
   * emit `link.transition` when an actual state change is committed, so we
   * do not duplicate the per-payment line. Illegal-transition re-applies
   * emit a single `link.transition.illegal` warning for grep.
   */
  async applyMatch(payment: NormalizedPayment, outcome: MatchOutcome, opts: ServiceCallOptions = {}): Promise<boolean> {
    // Use the ambient logger directly. Watcher passes a per-payment child
    // (`txHash + pagingToken` already bound); elsewhere txHash appears in the
    // per-event payload. Either way pino's parent chain + payload merge gives
    // us the correlations we need without re-binding the same key.
    const log = (opts.logger ?? this.deps.logger!);

    if (outcome.kind === "paid") {
      const link = outcome.link;
      if (!canTransition(link.status, "paid")) {
        log.warn(
          { event: "link.transition.illegal", linkId: link.id, txHash: payment.txHash, from: link.status, to: "paid" },
          "ignored payment (already settled)",
        );
        return false; // already settled/terminal
      }
      const from = link.status;
      await this.deps.links.recordPayment({
        linkId: link.id,
        txHash: payment.txHash,
        payer: payment.from,
        amount: normalizeAmount(payment.amount),
        asset: payment.asset,
        createdAt: Date.now(),
      });
      const cumulative = await this.deps.links.sumPaymentsForLink(link.id);
      link.status = "paid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = cumulative;
      link.overpaidAmount = outcome.overpaid ? normalizeAmount(outcome.overpaidAmount) : null;
      await this.deps.links.save(link);
      metrics.linkStatusTransitionsTotal.inc({ to: "paid" });
      log.info(
        { event: "link.transition", linkId: link.id, txHash: payment.txHash, from, to: "paid", overpaid: outcome.overpaid },
        "link paid",
      );
      const paidAt = Date.parse(payment.createdAt);
      if (!Number.isNaN(paidAt)) metrics.paymentToPaidLatencySeconds.observe((Date.now() - paidAt) / 1000);
      await this.fireWebhook(link, "link.paid", { overpaid: outcome.overpaid, overpaidAmount: link.overpaidAmount });
      return true;
    }

    if (outcome.kind === "underpaid") {
      const link = outcome.link;
      if (!canTransition(link.status, "underpaid")) {
        log.warn(
          { event: "link.transition.illegal", linkId: link.id, txHash: payment.txHash, from: link.status, to: "underpaid" },
          "ignored payment (already settled)",
        );
        return false;
      }
      const from = link.status;
      await this.deps.links.recordPayment({
        linkId: link.id,
        txHash: payment.txHash,
        payer: payment.from,
        amount: normalizeAmount(payment.amount),
        asset: payment.asset,
        createdAt: Date.now(),
      });
      const cumulative = await this.deps.links.sumPaymentsForLink(link.id);
      link.status = "underpaid";
      link.txHash = payment.txHash;
      link.payer = payment.from;
      link.paidAmount = cumulative;
      await this.deps.links.save(link);
      metrics.linkStatusTransitionsTotal.inc({ to: "underpaid" });
      log.info(
        { event: "link.transition", linkId: link.id, txHash: payment.txHash, from, to: "underpaid", outstanding: outcome.outstanding },
        "link underpaid",
      );
      await this.fireWebhook(link, "link.underpaid", { outstanding: outcome.outstanding });
      return false;
    }

    // Other outcomes (no_memo / unknown_reference / asset_mismatch) — these
    // are recorded by the watcher's `payment.matched` line just before the
    // service call. Nothing to log here.
    return false;
  }

  /**
   * Seller voids a link they created by mistake.
   *
   * Idempotent: cancelling an already-`cancelled` link returns the link unchanged
   * (no double-fire of the webhook). Any state from which `cancelled` is not
   * reachable (paid, off-ramp in flight, off-ramp settled, off-ramp failed,
   * already expired) is rejected with 409. 404 if the id is unknown.
   */
  async cancelLink(id: string): Promise<PaymentLink> {
    const link = await this.deps.links.findById(id);
    if (!link) throw new HttpError(404, "Link not found");

    // Idempotent: already cancelled -> no-op success, no second webhook.
    if (link.status === "cancelled") return link;

    if (!canTransition(link.status, "cancelled")) {
      throw new HttpError(409, `Link cannot be cancelled (is "${link.status}")`);
    }

    link.status = "cancelled";
    await this.deps.links.save(link);
    await this.fireWebhook(link, "link.cancelled", {});
    return link;
  }

  /**
   * Move any TTL'd link whose `expiresAt` is in the past to `expired`.
   *
   * Respects `canTransition`: only `active` and `underpaid` can become `expired`
   * (the transition table forbids everything else — paid and the off-ramp
   * states stay as-is). Idempotent across runs: a link already `expired` has
   * `status === "expired"` which fails the OPEN filter and is skipped.
   *
   * Returns the number of links flipped this sweep, so the caller can decide
   * whether to log. `now` is injected so tests can drive the clock.
   */
  async sweepExpired(now: number): Promise<number> {
    const seller = await this.deps.sellers.getDefault();
    const all = await this.deps.links.listBySeller(seller.id);
    let moved = 0;
    for (const link of all) {
      if (link.status !== "active" && link.status !== "underpaid") continue;
      if (link.expiresAt === null || link.expiresAt >= now) continue;
      if (!canTransition(link.status, "expired")) continue; // defense in depth
      link.status = "expired";
      await this.deps.links.save(link);
      await this.fireWebhook(link, "link.expired", { expiresAt: link.expiresAt });
      moved++;
    }
    return moved;
  }

  /**
   * A payment matched the memo of a link that is no longer open (expired or
   * cancelled). The link must not be resurrected — record the payment as
   * unmatched so the seller can refund the buyer out-of-band.
   *
   * The receiving link is included so the webhook payload carries the link
   * context the seller needs to identify the buyer and refund.
   */
  async recordUnmatchedPayment(payment: NormalizedPayment, link: PaymentLink): Promise<void> {
    await this.fireWebhook(link, "payment.unmatched", {
      payer: payment.from,
      paymentAmount: payment.amount,
      paymentAsset: payment.asset,
      paymentTxHash: payment.txHash,
    });
  }

  /**
   * Fetch a firm quote for a cash-out — gross, fee, and net — without
   * initiating anything (issue 1.5). Same gates as `triggerCashOut` up to
   * the quote step, so the seller sees exactly the numbers they'd get by
   * actually committing, but nothing state-changing happens here: no quote
   * is initiated, no job is created, the link is left untouched.
   */
  async quoteCashOut(linkId: string, targetCurrency: string, opts: ServiceCallOptions = {}): Promise<OffRampQuote> {
    const log = (opts.logger ?? this.deps.logger!);
    const link = await this.deps.links.findById(linkId);
    if (!link) throw new HttpError(404, "Link not found");
    if (link.status !== "paid") {
      throw new HttpError(409, `Link must be paid to cash out (is "${link.status}")`);
    }
    if (!this.health.isAvailable()) {
      throw new HttpError(503, "anchor_unavailable");
    }
    const kyc = await this.deps.kyc.status(link.sellerId);
    if (kyc.status !== "ACCEPTED") {
      throw new HttpError(403, "kyc_required");
    }

    const sourceAmount = link.paidAmount ?? link.amount;
    try {
      return await this.deps.offramp.quote(
        { linkId: link.id, sourceAsset: link.asset, sourceAmount, targetCurrency },
        { logger: log },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(502, `Off-ramp error: ${message}`);
    }
  }

  /** Seller-initiated cash-out: quote -> initiate -> move link to offramp_pending. */
  async triggerCashOut(
    linkId: string,
    body: CashOutBody,
    opts: ServiceCallOptions = {},
  ): Promise<{
    job: OffRampJob & { quoteExpiresAt: number; quoteExpiresInSeconds: number };
    initiation: OffRampInitiation;
  }> {
    const baseLog = (opts.logger ?? this.deps.logger!);
    const link = await this.deps.links.findById(linkId);
    if (!link) throw new HttpError(404, "Link not found");
    if (link.status !== "paid") {
      throw new HttpError(409, `Link must be paid to cash out (is "${link.status}")`);
    }
    const child = baseLog.child({ linkId: link.id });

    // Fail fast when the breaker is open: never attempt to call a known-dead
    // anchor. The HTTP layer maps this to 503 anchor_unavailable.
    if (!this.health.isAvailable()) {
      throw new HttpError(503, "anchor_unavailable");
    }

    // KYC is keyed by seller, never by link — a live cash-out is impossible
    // until the anchor has actually accepted this seller's identity. `status()`
    // re-syncs rather than trusting a cached value, since paying out against
    // stale/rejected KYC is exactly the failure this gate exists to prevent.
    const kyc = await this.deps.kyc.status(link.sellerId);
    if (kyc.status !== "ACCEPTED") {
      throw new HttpError(403, "kyc_required");
    }

    const sourceAmount = link.paidAmount ?? link.amount;

    // Extracted so the expiry guard below can ask for a second, fresh quote
    // without duplicating the request shape.
    const fetchFreshQuote = () =>
      this.deps.offramp.quote({
        linkId: link.id,
        sourceAsset: link.asset,
        sourceAmount,
        targetCurrency: body.targetCurrency,
      }, { logger: child });

    let quote: OffRampQuote;
    let initiation: OffRampInitiation;
    const t0 = Date.now();
    try {
      quote = await fetchFreshQuote();

      // Guard: reject quotes with unparsable or already-expired expiresAt.
      if (isQuoteExpired(quote)) {
        // One automatic re-quote in case of clock skew or a very short TTL.
        quote = await fetchFreshQuote();
        if (isQuoteExpired(quote)) {
          throw new QuoteExpiredError(quote.quoteId);
        }
      }
      child.info(
        {
          event: "cashout.quote",
          anchor: this.deps.offramp.mode,
          quoteId: quote.quoteId,
          targetCurrency: quote.targetCurrency,
          targetAmount: quote.targetAmount,
          rate: quote.rate,
          durationMs: Date.now() - t0,
        },
        "cash-out quoted",
      );

      const t1 = Date.now();
      initiation = await this.deps.offramp.initiate({
        linkId: link.id,
        quoteId: quote.quoteId,
        payout: { currency: body.targetCurrency, fields: body.payoutFields },
      }, { logger: child });
      child.info(
        {
          event: "cashout.initiate",
          anchor: this.deps.offramp.mode,
          jobId: initiation.jobId,
          durationMs: Date.now() - t1,
        },
        "cash-out initiated",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      child.error(
        { event: "cashout.error", anchor: this.deps.offramp.mode, error: message },
        "cash-out failed",
      );
      if (err instanceof HttpError) throw err;
      if (err instanceof QuoteExpiredError) {
        throw new HttpError(409, `quote_expired: ${err.message}`);
      }
      throw new HttpError(502, `Off-ramp error: ${message}`);
    }

    const from = link.status;
    const jobId = initiation.jobId;
    link.status = "offramp_pending";
    link.offrampJobId = jobId;
    link.offrampTargetCurrency = quote.targetCurrency;
    link.offrampStatus = "pending";

    // Telemetry (issue 3.5): persist the firm rate and the spread vs. indicative.
    // offrampIndicativeRate may already be set if the seller visited the preview
    // endpoint before committing; if not, we leave it null so the delta is skipped.
    link.offrampRate = quote.rate;
    if (link.offrampIndicativeRate !== null) {
      const indicative = Number(link.offrampIndicativeRate);
      const firm = Number(quote.rate);
      if (Number.isFinite(indicative) && Number.isFinite(firm) && indicative !== 0) {
        // Delta: firm − indicative (positive = anchor moved rate in seller's favour).
        link.offrampRateDelta = (firm - indicative).toFixed(6);
      }
    }

    // Fee (issue 1.5): persisted at initiation time so a receipt can reproduce
    // gross/fee/net without recomputing against a rate that may have moved on.
    link.offrampFeeAmount = quote.fee.amount;
    link.offrampFeeCurrency = quote.fee.currency;
    link.offrampFeeSource = quote.fee.source;
    link.offrampNetTargetAmount = quote.netTargetAmount;

    await this.deps.links.save(link);
    metrics.linkStatusTransitionsTotal.inc({ to: "offramp_pending" });
    child.info(
      { event: "link.transition", linkId: link.id, from, to: "offramp_pending", jobId },
      "cash-out initiated, link moved to offramp_pending",
    );
    this.cashOutStartedAt.set(link.id, Date.now());

    const job: OffRampJob = {
      jobId,
      linkId: link.id,
      status: "pending",
      targetCurrency: quote.targetCurrency,
      targetAmount: quote.targetAmount,
      rate: quote.rate,
    };

    const now = Date.now();
    const quoteExpiresInSeconds = Math.max(0, Math.floor((quote.expiresAt - now) / 1000));

    return {
      job: { ...job, quoteExpiresAt: quote.expiresAt, quoteExpiresInSeconds },
      initiation,
    };
  }

  /** Advance any pending cash-outs by polling the off-ramp adapter. */
  async pollCashOuts(opts: ServiceCallOptions = {}): Promise<void> {
    const log = (opts.logger ?? this.deps.logger!);
    const pending = await this.deps.links.listByStatus("offramp_pending");
    const now = Date.now();
    for (const link of pending) {
      if (!link.offrampJobId) {
        // Should never happen going forward (triggerCashOut always sets it),
        // but a link like this can't ever resolve — same fate as a lost job.
        await this.markOffRampFailed(link, "job_state_lost");
        continue;
      }
      // Per-job backoff: while the anchor is sick we don't re-ping it on every
      // tick. Skip links whose `next_try_at` is still in the future.
      const next = this.nextPollAtByLinkId.get(link.id);
      if (next !== undefined && now < next) continue;

      const child = log.child({ linkId: link.id, jobId: link.offrampJobId });
      let job: OffRampJob;
      try {
        job = await this.deps.offramp.status(link.offrampJobId, { logger: child });
        // Successful poll clears any prior in-memory last_error + backoff.
        this.lastPollErrorByLinkId.delete(link.id);
        this.consecutivePollErrorsByLinkId.delete(link.id);
        this.nextPollAtByLinkId.delete(link.id);
      } catch (err) {
        if (err instanceof OffRampJobNotFoundError) {
          // The adapter has no state for this job id at all — not a transient
          // hiccup, it will never resolve on its own. Fail it out so the
          // seller has a path forward instead of silent purgatory forever.
          await this.markOffRampFailed(link, "job_state_lost");
          this.lastPollErrorByLinkId.delete(link.id);
          this.consecutivePollErrorsByLinkId.delete(link.id);
          this.nextPollAtByLinkId.delete(link.id);
          continue;
        }
        // ATTRIBUTABLE: record the error against the link id so it can be
        // exposed in a follow-up PR (and is logged now). Without this catch
        // the swallowed error meant a downed anchor's failures evaporated.
        const message = err instanceof Error ? err.message : String(err);
        this.lastPollErrorByLinkId.set(link.id, message);
        console.warn(`[offramp] poll failed for link ${link.id}: ${message}`);
        // Exponential backoff per job (in-memory). Capped so a long-lived
        // pending job doesn't end up wedged for hours.
        const prev = this.consecutivePollErrorsByLinkId.get(link.id) ?? 0;
        const next1 = Math.min(LinkService.POLL_BACKOFF_CAP_MS, LinkService.POLL_BACKOFF_BASE_MS * 2 ** prev);
        this.consecutivePollErrorsByLinkId.set(link.id, prev + 1);
        this.nextPollAtByLinkId.set(link.id, Date.now() + next1);
        continue;
      }
      if (job.status === "settled") {
        const from = link.status;
        link.status = "offramp_settled";
        link.offrampStatus = "settled";
        await this.deps.links.save(link);
        metrics.linkStatusTransitionsTotal.inc({ to: "offramp_settled" });
        this.observeSettlementDuration(link.id, "settled");
        child.info({ event: "link.transition", from, to: link.status }, "off-ramp settled");
        await this.fireWebhook(link, "offramp.settled", {
          targetCurrency: job.targetCurrency,
          targetAmount: job.targetAmount,
        }, opts);
      } else if (job.status === "failed") {
        const from = link.status;
        link.status = "offramp_failed";
        link.offrampStatus = "failed";
        await this.deps.links.save(link);
        metrics.linkStatusTransitionsTotal.inc({ to: "offramp_failed" });
        this.observeSettlementDuration(link.id, "failed");
        child.info(
          { event: "link.transition", from, to: link.status, reason: job.reason },
          "off-ramp failed",
        );
        await this.fireWebhook(link, "offramp.failed", { reason: job.reason }, opts);
      }
    }
  }

  private observeSettlementDuration(linkId: string, outcome: "settled" | "failed"): void {
    const startedAt = this.cashOutStartedAt.get(linkId);
    if (startedAt === undefined) return; // process restarted mid-cash-out — no sample
    this.cashOutStartedAt.delete(linkId);
    metrics.quoteToSettlementDurationSeconds.observe({ outcome }, (Date.now() - startedAt) / 1000);
  }

  /**
   * Read the in-memory last poll error for a single link, if any. Surface this
   * in a follow-up PR; for now it's the attribution trail the issue asked for.
   */
  lastPollErrorFor(linkId: string): string | null {
    return this.lastPollErrorByLinkId.get(linkId) ?? null;
  }

  /**
   * Snapshot of the anchor health probe + circuit breaker, surfaced by the
   * `/health` endpoint so a downed anchor is observable from operators (and
   * from the seller-facing dashboard in a follow-up).
   */
  healthSnapshot(): AnchorHealthSnapshot {
    return this.health.snapshot();
  }

  /**
   * Boot-time repair: a link can be stuck in `offramp_pending` with a job id
   * that has no corresponding row in the off-ramp state store — the fallout
   * of the pre-fix in-memory Maps not surviving a restart. Nothing can recover
   * that lost job state, so move the link to `offramp_failed` (a domain-level
   * retryable state) instead of leaving it in permanent limbo.
   */
  async backfillLostOffRampJobs(): Promise<number> {
    const pending = await this.deps.links.listByStatus("offramp_pending");
    let fixed = 0;
    for (const link of pending) {
      const job = link.offrampJobId ? await this.deps.offrampState.getJob(link.offrampJobId) : null;
      if (job) continue;
      await this.markOffRampFailed(link, "job_state_lost");
      fixed++;
    }
    return fixed;
  }

  private async markOffRampFailed(link: PaymentLink, reason: string): Promise<void> {
    if (!canTransition(link.status, "offramp_failed")) return;
    link.status = "offramp_failed";
    link.offrampStatus = "failed";
    await this.deps.links.save(link);
    await this.fireWebhook(link, "offramp.failed", { reason });
  }

  private async fireWebhook(
    link: PaymentLink,
    event: string,
    extra: Record<string, unknown>,
    opts: ServiceCallOptions = {},
  ): Promise<void> {
    const hooks = await this.deps.webhooks.listBySeller(link.sellerId);
    if (hooks.length === 0) return;
    await this.sender.dispatch(hooks, link.id, {
      event,
      data: {
        linkId: link.id,
        reference: link.reference,
        status: link.status,
        amount: link.amount,
        paidAmount: link.paidAmount,
        asset: link.asset,
        txHash: link.txHash,
        ...extra,
      },
    }, { logger: opts.logger ?? this.deps.logger! });
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}