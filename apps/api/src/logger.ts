import { pino, type Logger as PinoLogger } from "pino";

/**
 * Redact paths applied to EVERY logged object. These are intentional floors,
 * not an exhaustive allow-list: any future logged object that holds one of
 * these keys will be masked automatically. Match pino's dotted syntax — `*`
 * matches a single level, `**` not supported.
 *
 * What each family guards:
 *  - secret / token / jwt        → webhook signing secrets, SEP-10 challenge
 *                                  tokens cached on disk, any JWT we cache
 *  - authorization               → Bearer token in any logged fetch request
 *                                  (SEP-10, SEP-38, SEP-12, SEP-6)
 *  - defaultSellerSecret         → DEFAULT_SELLER_SECRET env var if ever logged
 *  - payout / payoutFields       → cash-out body (NGN target, fields map)
 *  - first_name / last_name /
 *    email_address               → SEP-12 KYC payload (every field is PII)
 *  - *.fields.*                  → defensive — the SEP-12 PUT body shape
 */
export const REDACT_PATHS: string[] = [
  // generic secret-shaped fields
  "secret",
  "*.secret",
  "token",
  "*.token",
  "jwt",
  "*.jwt",
  // access credentials
  "authorization",
  "Authorization",
  "*.authorization",
  "*.Authorization",
  "headers.authorization",
  "headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  // env leaks (e.g. process.env dumped for debugging)
  "defaultSellerSecret",
  "DEFAULT_SELLER_SECRET",
  // cash-out payload — opaque to the domain, anchor interprets it
  "payout",
  "payoutFields",
  // SEP-12 KYC PII — every field is personal data
  "first_name",
  "last_name",
  "email_address",
  "address",
  "*.first_name",
  "*.last_name",
  "*.email_address",
  "*.address",
  "fields",
  "*.fields",
];

const REDACT_CENSOR = "[REDACTED]";

export interface CreateLoggerOptions {
  /** Pino level (default "info"). Honoured from env.LOG_LEVEL by the caller. */
  level?: string;
  /** Static bindings included on every line (e.g. service name, env). */
  base?: Record<string, unknown>;
}

/**
 * Build the root pino logger. Apps wire this once at boot. Every other
 * component receives either the root or a `child()` of it bound with a
 * correlation id (requestId / linkId / jobId / txHash).
 *
 * `pino.Logger` is structurally assignable to the `@checkout/core` `Logger`
 * port surface (`info|warn|error|debug|child`), so no adapter wrapper is
 * needed — and importantly, no wrapper that loses arg shape via casts.
 */
export function createLogger(opts: CreateLoggerOptions = {}): PinoLogger {
  return pino({
    level: opts.level ?? "info",
    base: { service: "checkout-api", ...opts.base },
    // Render a useful timestamp prefix for grepping on Render's text stream.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  });
}
