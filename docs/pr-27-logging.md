# 4.7 — Structured logging with correlation IDs · Closes #27

## TL;DR

Replaces ad-hoc `[api]` / `[watcher]` console logs with **pino JSON lines** whose level comes from `LOG_LEVEL` and whose redact list protects every secret/PII family the brief calls out. Adds a **request middleware that mints or honors `x-request-id`** and binds a child logger carrying requestId/method/path onto the Hono context. Threads that child logger — plus `linkId`/`jobId`/`quoteId`/`webhookId`/`txHash` siblings — **through every public method of `LinkService`, `WebhookSender`, and `OffRampPort`** so a single `requestId` greps the whole cash-out chain end to end, on Render, with full identifiers (no `short()` truncator in JSON output).

## Diff at a glance

```
 3 new files:
   packages/core/src/ports/logger.ts        (+57)
   apps/api/src/logger.ts                   (+90)
   apps/api/src/request-context.ts          (+72)

18 files changed · 692 insertions · 140 deletions
   .env.example                            |   4 +
   apps/api/package.json                   |   9 +-
   apps/api/src/env.ts                     |   2 +
   apps/api/src/index.ts                   |  27 ++++--
   apps/api/src/routes/links.ts            |  50 ++++++++--
   apps/api/src/routes/webhooks.ts         |  12 ++-
   apps/api/src/services/container.ts      |  86 ++++++++++++-----
   apps/api/src/services/link-service.ts   | 163 +++++++++++++++++++++++++++-----
   apps/api/src/services/webhook-sender.ts |  50 +++++++++-
   apps/api/src/worker/watcher-loop.ts     |  62 ++++++++----
   packages/core/src/ports/index.ts        |  17 +++-
   packages/offramp/package.json           |   7 +-
   packages/offramp/src/mock-anchor.ts     |  60 +++++++++---
   packages/offramp/src/sep10.ts           |  46 ++++++++-
   packages/offramp/src/sep38.ts           |  31 +++++-
   packages/offramp/src/sep6.ts            |  44 ++++++++-
   packages/offramp/src/testanchor.ts      |  56 +++++++----
   pnpm-lock.yaml                          | 106 ++++++++++++++++++++-
```

CI: **`pnpm typecheck` 5/5 green · `pnpm test` 30/30 (29 core + 3 offramp; 2 are skipped behind `RUN_LIVE_ANCHOR_TESTS=1`)**.

## Why this matters

On Render the old flow was one flat text stream. A buyer clicked cash-out → SEP-10 auth → SEP-38 quote → SEP-6 withdraw → poll settled produced five `[api]` / `[watcher]` lines with **different prefixes, no shared correlation, and a truncated tx hash**. Every `support: "the cash-out hung"` question turned into archaeology. The redact list now ensures none of that archaeology leaks a secret into a grep.

## What's actually new

### pino factory — `apps/api/src/logger.ts`

```ts
export function createLogger(opts: CreateLoggerOptions = {}): PinoLogger {
  return pino({
    level: opts.level ?? "info",
    base: { service: "checkout-api", ...opts.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  });
}
```

`LOG_LEVEL` is wired through `apps/api/src/env.ts` (`process.env.LOG_LEVEL || "info"`). Default `info`, valid values `trace|debug|info|warn|error|fatal`. ISO-8601 timestamps so Render's text stream is greppable by time and id at the same moment.

### Redact list — defensive floor

| Path | Family | Why |
|---|---|---|
| `secret` / `*.secret` | webhook signing secret | computed HMAC key per registered hook |
| `token` / `*.token` / `jwt` / `*.jwt` | SEP-10 challenge response `token` cache | Bearer credential |
| `authorization` / `Authorization` / `*.authorization` / `*.Authorization` | log-spilled fetch headers | occasionally logged for debugging |
| `headers.authorization` / `headers.Authorization` / `*.headers.authorization` / `*.headers.Authorization` | SEP request `Authorization: Bearer …` | every SEP call |
| `defaultSellerSecret` / `DEFAULT_SELLER_SECRET` | env var leakage if any debug log ever dumps `process.env` | defense |
| `payout` / `payoutFields` | cash-out body (NGN target, fields map) | opaque but anchor-interpreted |
| `first_name` / `last_name` / `email_address` / `address` + each `*.<name>` | SEP-12 KYC payload | every field is PII |
| `fields` / `*.fields` | SEP-12 PUT request body shape | belt for `first_name` suspenders |

Censor is the literal string `[REDACTED]`, never blank — that way audit logs prove redaction *happened* even if the line ends up empty.

### `@checkout/core` logger port — `packages/core/src/ports/logger.ts`

A 60-line strict port. No pino dependency leaks into adapter code:

```ts
export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}
export const NOOP_LOGGER: Logger = { child: () => NOOP_LOGGER, info: noop, warn: noop, error: noop, debug: noop };
```

`pino.Logger` is **structurally assignable** to this port, so the api wires the root pino logger directly — no adapter wrapper, no shape-unsafe casting.

### Request middleware — `apps/api/src/request-context.ts`

```ts
export function requestContext(rootLogger: Logger): MiddlewareHandler<AppEnv> {
  return async (ctx, next) => {
    const incoming = ctx.req.header("x-request-id");
    const requestId = isSafeRequestId(incoming) ? incoming : randomUUID();
    const child = rootLogger.child({ requestId, method: ctx.req.method, path: ctx.req.path });
    ctx.set("requestId", requestId);
    ctx.set("logger", child);
    ctx.header("x-request-id", requestId);
    return next();
  };
}
```

`isSafeRequestId` rejects anything that isn't printable ASCII, 8–200 chars, no whitespace — so a malicious caller cannot inject a fake id into the log stream to mislead on-call searches. **Installed before `cors` and `rate-limit`** so even a 429 carries the id.

### Correlation propagation through the seam

Every public method on **`LinkService`**, **`WebhookSender`**, and **`OffRampPort`** now takes `opts?: { logger?: Logger }`:

| Component | Method | Older signature | New signature |
|---|---|---|---|
| `LinkService` | `createLink(body)` → `createLink(body, opts)` | `Promise<LinkWithRequest>` | routes pass `{ logger: ctxLog }` |
| `LinkService` | `listLinks()`, `getLink(id)`, `pollCashOuts()` | same + trailing opts | each takes opts |
| `LinkService` | `applyMatch(payment, outcome)` → `applyMatch(payment, outcome, opts)` | watcher passes `{ logger: perPaymentChild }` |
| `LinkService` | `triggerCashOut(linkId, body)` → adds opts | routes pass ctxLog |
| `WebhookSender` | `dispatch(hooks, linkId, event)` → adds opts | service threads it through |
| `OffRampPort` | `quote/initiate/status` | `(opts?: { logger?: Logger })` | service passes the per-link child |
| `Sep10Client` | `token()` | `token(opts?: { logger?: Logger })` | offramp passes through |

Internally: `const log = opts?.logger ?? this.deps.logger` so the caller's binding is preserved. The pino child's parent-chain is immutable after `child()` — so the requestId from Hono survives every `.child({linkId})` / `.child({jobId})` chained below it.

A complete trace now looks like:

```
{cashout.request.received}  → POST /links/:id/cash-out, requestId=req_demo, linkId=lnk_abc
{cashout.quote}             → SEP-38 attempt start
{anchor.sep10.challenge.start}
{anchor.sep10.auth.ok}      → SEP-10 cached, requestId, linkId baked
{anchor.sep38.quote.ok}     → requestId, linkId, quoteId
{cashout.initiate}          → requestId, jobId=ofr_xyz
{anchor.sep12.put.ok}       → requestId, jobId   (PII fields masked)
{anchor.sep6.withdraw.ok}   → requestId, jobId, withdrawId
{link.transition}           → requestId, linkId, from paid → offramp_pending
{webhook.attempt}           → requestId, linkId, webhookId, attempt #, statusCode
…(background tick later)…
{anchor.sep6.status.ok}     → linkId, jobId
{link.transition}           → linkId, jobId   offramp_settled, targetAmount
{webhook.attempt}           → linkId, webhookId, delivered: true
```

`grep req_demo` in Render's log stream returns *all* of the above. Joining on `linkId` returns them too, and joining on `jobId` returns the off-ramp lifecycle. Joining on `txHash` returns the watcher's settle path.

### One structured line per required moment

The brief's "one line per …" requirement is satisfied by an explicit event list:

| Required moment | Event name(s) | Owner |
|---|---|---|
| per payment matched | `payment.matched` (sole owner) | `WatcherLoop.processAccount` |
| per state transition | `link.transition` *or* `link.transition.illegal` | `LinkService.{applyMatch,pollCashOuts,triggerCashOut}` |
| per webhook attempt | `webhook.attempt` (delivered/willRetry) + `webhook.failed` terminal | `WebhookSender.deliver` |
| per anchor call | `anchor.sep10.{challenge.start, auth.{ok,fail}}`, `anchor.sep38.quote.{start,ok,fail}`, `anchor.sep12.put.{start,ok,fail}`, `anchor.sep6.withdraw.{start,ok,fail}`, `anchor.sep6.status.{ok,fail}`, `anchor.mock.{quote,initiate,status.transition}` | `Sep10Client` / `sep38.ts` / `sep6.ts` / `MockAnchorOffRamp` / `TestAnchorOffRamp` |

Plus process events the on-call uses:

- boot: `seller.configured` / `seller.generated` / `offramp.selected` / `watcher.start` / `api.listening` / `api.shutdown`
- routes (request lifecycle instrumentation): `link.create.{invalid,ok,error}`, `cashout.invalid`, `cashout.request.{received,ok,rejected,error}`, `webhook.register.{invalid,registered}`
- watcher bookkeeping: `watcher.account.{seeded,batch,idle,error}`, `watcher.tick.error`, `cashout.tick.error`, `payment.duplicate`, `cashout.poll.error`
- lifecycle safety nets: `link.transition.illegal`, `cashout.error`, `webhook.failed`

**No duplicate emissions.** `LinkService.applyMatch` no longer carries an inner `logPayment` helper — the watcher's `payment.matched` line is the sole owner of that event so a single payment produces exactly one grep-able line.

### Full identifiers, no `short()` in JSON

Removed every `short()` truncator from logged paths. `txHash`, `linkId`, `reference`, `jobId`, `webhookId`, `quoteId`, `pagingToken`, hook URL host (path stripped for paranoid-grep safety): all written in full.

The one remaining plaintext-to-stdout output is the testnet key banner, gated to **`process.env.LOG_LEVEL === "debug" || "trace"`** and emitted via `process.stdout.write` *outside pino's pipeline* — so a normal pino run never echoes a secret into the JSON stream, and the redact list is belt-and-suspenders if you opt into the debug banner.

### No `console.*` remains

A grep for `\bconsole\.(log|warn|error|info|debug)\b` across `apps/api/src/` returns zero matches. The single surviving write call is `process.stdout.write` in `container.ts#resolveSellerKeypairOrWallet` (the gated debug banner noted above) and `process.stderr.write` in `index.ts`'s boot-fatal catch.

## Backward compatibility

- `packages/offramp/test/testanchor.test.ts` still instantiates `new TestAnchorOffRamp({ sellerKeypair: Keypair.random() })` with **no logger**. The constructor's `logger?` is optional and falls back to `NOOP_LOGGER`. Test passes unchanged.
- `LinkService` and `WebhookSender` legacy callers (background `startCashOutPoller`, watcher tick) pass no `opts.logger`; the service falls back to `this.deps.logger` (the root). No behavior change.
- No public HTTP-shape changes: routes return the same JSON they did before. The only added response header is `x-request-id`.

## Trade-offs explicit on-record

- **No `AsyncLocalStorage`.** Considered and rejected — explicit `opts?.logger` threading is grep-able by a human, and the marginal cost is one optional parameter per service method. ALS would be invisible to a future maintainer reading the code.
- **`Logger` interface is loose on arity (`...args: unknown[]`).** Loses pino's overload-fidelity for message/object overloads — but runtime args pass through untyped, pino handles the shape. Tradeoff: simpler implementation, slightly weaker type narrowing for callers, which we don't need because all call sites in this codebase use `({event, ...}, "msg")` shape consistently.
- **Redact list is case-folded.** Pino's path matcher is case-sensitive at every level, so we list `'authorization'` and `'Authorization'` separately (totalling 8 entries for the family). Verbose but defensible — pino's wildcards match what Node `fetch` actually emits (`headers.authorization`, lowercase).
- **Webhooks emit requestId for route-driven cash-outs.** If a hook receiver has its own log correlation scheme (Datadog trace id, etc.), they'll receive the body without our request correlation. We document `x-checkout-event` and `x-checkout-signature` in the existing API.md; this PR doesn't add anything receiver-side.

## Migration / ops

### Deploying

No migration step. The pino instance is created on boot in `createContainer()`. The redact list applies to *every* log emission from boot — security posture improves the instant this lands. No DB schema change.

### New env var

```
LOG_LEVEL=info        # trace | debug | info | warn | error | fatal; default info
```

`.env.example` updated. Render dashboard: `quay-api → Environment → Add LOG_LEVEL`.

### New response header

`x-request-id: <uuid or echoed>` on every API response (incl. 4xx, 5xx, 429 rate-limit). Clients can include this in support tickets; the server-side trace stitches by it via grep.

### New request header (recommended client behaviour)

Clients MAY send `x-request-id` on inbound requests. The middleware validates the inbound value (printable ASCII, 8–200 chars) and reuses it, otherwise mints. Useful for *app-side* tracing (e.g., a frontend error reporter getting a request id from the server and forwarding it to the error tracker).

## Reproduction recipe (for the on-call engineer)

```bash
# Start the API with debug logging.
LOG_LEVEL=debug pnpm --filter @checkout/api dev

# In another terminal, mint a link with correlation:
RESP=$(curl -sS -H 'x-request-id: req_demo_001' -H 'content-type: application/json' \
  -d '{"title":"demo","amount":"5","assetCode":"USDC"}' \
  http://localhost:8787/links)
echo "$RESP" | jq -r '.link.id'

# Trigger a cash-out, same correlation id:
LINK_ID=$(echo "$RESP" | jq -r '.link.id')
curl -sS -H 'x-request-id: req_demo_001' -H 'content-type: application/json' \
  -d '{"targetCurrency":"NGN","payoutFields":{}}' \
  "http://localhost:8787/links/$LINK_ID/cash-out"

# The whole story is one grep away:
grep req_demo_001 logs/api.jsonl | jq -r '
  [ .ts, .event,
    .requestId // "-",
    .linkId // .jobId // "-",
    .quoteId // .webhookId // "-" ] | @tsv'
```

Expected output shape (abridged):

```
2025-…  link.create.ok                 req_demo_001 lnk_yyy        -
2025-…  link.created                   req_demo_001 lnk_yyy        -
2025-…  cashout.request.received       req_demo_001 lnk_yyy        -
2025-…  cashout.quote                  req_demo_001 lnk_yyy        quote_q1
2025-…  anchor.sep10.challenge.start   req_demo_001 lnk_yyy        -
2025-…  anchor.sep10.auth.ok           req_demo_001 lnk_yyy        -
2025-…  anchor.sep38.quote.ok          req_demo_001 lnk_yyy        quote_q1
2025-…  cashout.initiate               req_demo_001 lnk_yyy        -
2025-…  anchor.sep12.put.ok            req_demo_001 lnk_yyy        -
2025-…  anchor.sep6.withdraw.ok        req_demo_001 lnk_yyy        -
2025-…  link.transition                req_demo_001 lnk_yyy        -
2025-…  webhook.attempt                req_demo_001 lnk_yyy        whk_a1
```

(Payout fields are masked by prune — even with `LOG_LEVEL=debug` you cannot see `first_name`, the Bearer token, or a webhook secret.)

## Acceptance ↔ implementation trace

| Done-when statement | Where it's satisfied |
|---|---|
| Adopt pino (JSON lines, level from `LOG_LEVEL`) | `apps/api/src/logger.ts#createLogger` + `apps/api/src/env.ts#logLevel` |
| Request middleware assigns requestId (honour inbound `x-request-id`) and binds a child logger onto the context | `apps/api/src/request-context.ts#requestContext`; `getLogger(ctx)` exposes it typed |
| Propagate a `linkId` / `jobId` correlation field through LinkService, watcher, off-ramp adapters | `LinkService` child loggers (`linkId + reference`); `WatcherLoop.processAccount` per-account + per-payment children; `OffRampPort`/`Sep10Client`/`getSep38*`/`putSep*`/`startSep6*`/`getSep6*` thread `opts?.logger` |
| Redact secrets and PII by path: `DEFAULT_SELLER_SECRET`, SEP-10 JWTs, webhook secrets, every SEP-12 field | `REDACT_PATHS` in `apps/api/src/logger.ts` (28 entries with documented family-level intent above) |
| Log full identifiers; keep `short()` for human-facing only | `process.stdout.write` testnet banner is the only remaining `short()` user; all JSON emits full `txHash`/`linkId`/`jobId`/`quoteId`/`webhookId`/`pagingToken` |
| Emit one structured line per payment matched / state transition / webhook attempt / anchor call | `payment.matched` (sole owner in watcher), `link.transition` / `link.transition.illegal`, `webhook.attempt` / `webhook.failed`, `anchor.sep10.*` / `anchor.sep38.*` / `anchor.sep12.*` / `anchor.sep6.*` / `anchor.mock.*` |

**Done when:**

- One `requestId` traces a cash-out end to end through every subsystem — `cashout.request.received` → `cashout.quote` → `anchor.sep10.auth.ok` → `anchor.sep38.quote.ok` → `cashout.initiate` → `anchor.sep12.put.ok` → `anchor.sep6.withdraw.ok` → `link.transition` → background `anchor.sep6.status.ok` → `link.transition` (settled).
- No secret or PII value can appear in a log line — pino redact at the root + adapter-side never-pass discipline (e.g. `putSep12Customer` never passes `fields` to a log line; `LinkService` redacts `payoutFields`).

## CI verification (executed before push)

```
$ pnpm typecheck
 Tasks:  5 successful, 5 total         # core, stellar, offramp, web, api

$ pnpm test
 @checkout/core:   29 passed (4 files)
 @checkout/offramp: 3 tests | 1 passed, 2 skipped (RUN_LIVE_ANCHOR_TESTS=1)
 Tasks:  2 successful, 2 total
```

## Files touched (final list)

New:

- `packages/core/src/ports/logger.ts` — tiny `Logger` interface + `NOOP_LOGGER`.
- `apps/api/src/logger.ts` — pino factory + `REDACT_PATHS`.
- `apps/api/src/request-context.ts` — Hono middleware + `getLogger`/`getRequestId` typed accessors.

Modified:

- `packages/core/src/ports/index.ts` — `OffRampPort.{quote,initiate,status}` accept `opts?: { logger?: Logger }`; re-exports `Logger` + `NOOP_LOGGER`.
- `packages/offramp/{package.json, sep10.ts, sep38.ts, sep6.ts, testanchor.ts, mock-anchor.ts}` — every adapter accepts an optional `Logger`; emits `anchor.*` events with deterministic event names.
- `apps/api/package.json` + `apps/api/src/{env.ts, index.ts, services/container.ts, services/link-service.ts, services/webhook-sender.ts, worker/watcher-loop.ts, routes/links.ts, routes/webhooks.ts}` — root pino logger, threaded logger propagation, structured-event emission, `console.*` eliminated.
- `.env.example` — documents `LOG_LEVEL`.

---

`Closes #27`
