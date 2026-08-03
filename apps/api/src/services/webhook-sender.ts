import { createHmac } from "node:crypto";
import type { Webhook, WebhookRepository } from "@checkout/core";
import { decryptSecret } from "./secret-crypto";
import { metrics } from "../metrics";
import { guardWebhookUrl } from "./ssrf-guard";

const HOST_ALLOWLIST = process.env.WEBHOOK_HOST_ALLOWLIST
  ? process.env.WEBHOOK_HOST_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

export interface WebhookEvent {
  event: string; // e.g. "link.paid"
  data: Record<string, unknown>;
}

export interface WebhookSenderOptions {
  /** Total delivery attempts per hook before giving up (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms; doubles each retry, with jitter (default 500). */
  baseDelayMs?: number;
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
  /** Cap on response body reads in bytes (default 64 KB). */
  maxResponseBytes?: number;
  /**
   * URL guard used at delivery time. Defaults to the real SSRF guard; tests
   * inject a permissive one so they can point at a loopback stub without
   * disabling the guard globally.
   */
  guard?: (url: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * Delivers events to a seller's registered webhooks. The body is signed with
 * HMAC-SHA256 using the per-webhook secret, sent as `X-Checkout-Signature`.
 * Receivers verify by recomputing the HMAC over the exact raw body, and should
 * reject events whose in-body `sentAt` is too old (replay protection — `sentAt`
 * is inside the signed body, so it cannot be tampered with).
 *
 * If a secret was rotated less than 24h ago, the previous secret is also
 * accepted as a valid signer and both signatures are sent (see `deliver`) —
 * this is what makes rotation zero-downtime for the receiver.
 *
 * Delivery is retried with exponential backoff on transient failures (network
 * errors and 5xx / 429 responses). 4xx (other than 429) is treated as a
 * permanent failure and not retried. Only the final outcome is recorded.
 *
 * Security:
 *   - The URL is re-validated via guardWebhookUrl at delivery time to defeat
 *     DNS-rebinding attacks (the guard resolves the hostname and checks every
 *     returned address against private/reserved ranges).
 *   - redirect: "manual" — 3xx responses are treated as a failed attempt; the
 *     guard is NOT applied to redirect targets.
 *   - Response bodies are read up to maxResponseBytes and then discarded to
 *     prevent memory exhaustion.
 *
 * NOTE: retries are in-process — a crash mid-backoff loses pending retries.
 * A durable queue is the production answer; this hardens the common transient case.
 */
function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export class WebhookSender {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly guard: NonNullable<WebhookSenderOptions["guard"]>;
  private inFlight = 0;

  constructor(
    private readonly repo: WebhookRepository,
    opts: WebhookSenderOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024;
    this.guard = opts.guard ?? ((url: string) => guardWebhookUrl(url, { allowlist: HOST_ALLOWLIST }));
    this.maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024; // 64 KB
  }

  /** Deliveries currently in progress, including in-process retry backoff. */
  get inFlightCount(): number {
    return this.inFlight;
  }

  async dispatch(hooks: Webhook[], linkId: string, event: WebhookEvent): Promise<void> {
    const body = JSON.stringify({ ...event, id: linkId, sentAt: new Date().toISOString() });

    await Promise.all(hooks.map((hook) => this.deliver(hook, linkId, event.event, body)));
  }

  private async deliver(
    hook: Webhook,
    linkId: string,
    event: string,
    body: string,
  ): Promise<void> {
    // Re-check the URL at delivery time: a hostname that resolved to a public
    // address at registration may resolve to an internal one now. This narrows
    // the DNS-rebinding window but does not close it — the fetch below still
    // resolves the hostname itself, so the connection is not pinned to the
    // address we checked. See the follow-up noted on PR #108.
    const guard = await this.guard(hook.url);
    if (!guard.ok) {
      await this.repo.recordDelivery({
        webhookId: hook.id,
        linkId,
        event,
        statusCode: null,
        ok: false,
        error: `SSRF guard rejected URL at delivery: ${guard.reason}`,
      });
      return;
    }

    const signature = sign(decryptSecret(hook.secretEncrypted), body);

    // During the post-rotation overlap window, also sign with the previous
    // secret and send both — so a receiver that hasn't redeployed with the
    // new secret yet still verifies successfully, and drops no events.
    // Signatures are comma-separated in one header (`sha256=<new>,sha256=<old>`);
    // a receiver should accept the delivery if *any* listed signature matches.
    const stillInOverlap =
      hook.previousSecretEncrypted !== null &&
      hook.previousSecretExpiresAt !== null &&
      hook.previousSecretExpiresAt > Date.now();
    const signatureHeader = stillInOverlap
      ? `sha256=${signature},sha256=${sign(decryptSecret(hook.previousSecretEncrypted!), body)}`
      : `sha256=${signature}`;

    let statusCode: number | null = null;
    let error: string | null = null;

    this.inFlight += 1;
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          const res = await fetch(hook.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-checkout-signature": signatureHeader,
              "x-checkout-event": event,
            },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
            // Never follow redirects: a 3xx is the classic way to walk an
            // allowed public host round to an internal one, and the guard is
            // not re-applied to redirect targets (issue #23 item 3).
            redirect: "manual",
          });

          // `redirect: "manual"` surfaces 3xx as an ordinary response rather
          // than following it. Treat it as a failed attempt, not a success.
          if (res.status >= 300 && res.status < 400) {
            metrics.webhookAttemptsTotal.inc({ result: "error" });
            statusCode = res.status;
            error = `HTTP ${res.status} (redirect not followed)`;
            await this.drainCapped(res);
            break; // a receiver redirecting us is a config error, not transient
          }

          await this.drainCapped(res);

          if (res.ok) {
            metrics.webhookAttemptsTotal.inc({ result: "ok" });
            await this.repo.recordDelivery({ webhookId: hook.id, linkId, event, statusCode: res.status, ok: true, error: null });
            return;
          }

          metrics.webhookAttemptsTotal.inc({ result: "error" });
          statusCode = res.status;
          error = `HTTP ${res.status}`;
          // 4xx (except 429) is a client error the receiver won't fix on retry.
          if (res.status < 500 && res.status !== 429) break;
        } catch (err) {
          metrics.webhookAttemptsTotal.inc({ result: "error" });
          statusCode = null;
          error = err instanceof Error ? err.message : String(err);
        }

        if (attempt < this.maxAttempts) await sleep(this.backoff(attempt));
      }

      await this.repo.recordDelivery({ webhookId: hook.id, linkId, event, statusCode, ok: false, error });
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Read at most `maxResponseBytes` of the body and discard it. Webhook
   * receivers are not supposed to return anything meaningful, and an
   * unbounded read is a memory-exhaustion vector (issue #23 item 4).
   */
  private async drainCapped(res: Response): Promise<void> {
    const body = res.body;
    if (!body) return;
    const reader = body.getReader();
    let read = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value?.byteLength ?? 0;
        if (read > this.maxResponseBytes) {
          await reader.cancel();
          break;
        }
      }
    } catch {
      // A truncated/aborted body is not itself a delivery failure.
    }
  }

  /** Exponential backoff with full jitter. */
  private backoff(attempt: number): number {
    const ceiling = this.baseDelayMs * 2 ** (attempt - 1);
    return Math.floor(Math.random() * ceiling);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read and discard up to `cap` bytes from a ReadableStream. */
async function drainCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<void> {
  const reader = stream.getReader();
  let read = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value?.byteLength ?? 0;
      if (read >= cap) break;
    }
  } finally {
    reader.releaseLock();
  }
}
