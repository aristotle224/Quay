import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

export interface Sep10Options {
  baseUrl: string;
  homeDomain: string;
}

interface CachedToken {
  token: string;
  exp: number; // epoch seconds
}

/**
 * Fetches and caches a SEP-10 web-auth JWT for one Stellar account against one
 * anchor. https://testanchor.stellar.org/auth is the reference implementation
 * of https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * The JWT is treated as a secret: it is NEVER logged. The logger (if provided)
 * receives one `anchor.sep10.auth` event per token fetch with just the publicKey
 * and cached expiry — enough to correlate a cash-out without exposing the bearer.
 */
export class Sep10Client {
  private cached: CachedToken | null = null;
  private readonly logger: Logger;
  private ranOnce = false;

  constructor(
    private readonly keypair: Keypair,
    private readonly opts: Sep10Options,
    logger?: Logger,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child({ component: "sep10", baseUrl: opts.baseUrl });
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * @param opts Optional overrides — pass a request-bound logger so the SEP-10
   * auth event inherits the calling request's correlation ids.
   */
  async token(opts?: { logger?: Logger }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.exp - 60 > now) return this.cached.token;
    this.cached = await this.fetchToken(opts?.logger);
    return this.cached.token;
  }

  private async fetchToken(overrideLogger?: Logger): Promise<CachedToken> {
    const baseLog = overrideLogger ?? this.logger;
    const child = baseLog.child({ publicKey: this.keypair.publicKey() });
    const challengeUrl = new URL("/auth", this.opts.baseUrl);
    challengeUrl.searchParams.set("account", this.keypair.publicKey());
    challengeUrl.searchParams.set("home_domain", this.opts.homeDomain);

    const t0 = Date.now();
    child.info({ event: "anchor.sep10.challenge.start" }, "fetching SEP-10 challenge");
    const challengeRes = await fetch(challengeUrl);
    if (!challengeRes.ok) {
      child.warn({ event: "anchor.sep10.challenge.fail", statusCode: challengeRes.status, durationMs: Date.now() - t0 }, "SEP-10 challenge failed");
      throw new Error(`SEP-10 challenge fetch failed: ${challengeRes.status} ${await challengeRes.text()}`);
    }
    const { transaction, network_passphrase } = (await challengeRes.json()) as {
      transaction: string;
      network_passphrase: string;
    };

    const tx = TransactionBuilder.fromXDR(transaction, network_passphrase);
    if (!(tx instanceof Transaction)) {
      throw new Error("SEP-10 challenge was not a signable Transaction");
    }
    tx.sign(this.keypair);

    const t1 = Date.now();
    const authRes = await fetch(new URL("/auth", this.opts.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.toXDR() }),
    });
    if (!authRes.ok) {
      child.warn({ event: "anchor.sep10.auth.fail", statusCode: authRes.status, durationMs: Date.now() - t1 }, "SEP-10 auth submit failed");
      throw new Error(`SEP-10 auth submit failed: ${authRes.status} ${await authRes.text()}`);
    }
    const { token } = (await authRes.json()) as { token: string };
    const exp = decodeJwtExp(token);
    // One structured line per token, NEVER include `token` itself. Even if
    // some future refactor accidentally passes it through, pino's redact
    // list (`*.token`) is the second line of defence.
    child.info(
      {
        event: "anchor.sep10.auth.ok",
        expiresAt: new Date(exp * 1000).toISOString(),
        durationMs: Date.now() - t1,
        cached: this.ranOnce,
      },
      "SEP-10 auth ok",
    );
    this.ranOnce = true;
    return { token, exp };
  }
}

function decodeJwtExp(token: string): number {
  const fallback = Math.floor(Date.now() / 1000) + 300; // 5 min if unparsable
  const payload = token.split(".")[1];
  if (!payload) return fallback;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return json.exp ?? fallback;
  } catch {
    return fallback;
  }
}
