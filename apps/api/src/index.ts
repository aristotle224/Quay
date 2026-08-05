import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./env";
import { createContainer } from "./services/container";
import { linkRoutes } from "./routes/links";
import { webhookRoutes } from "./routes/webhooks";
import { publicRoutes } from "./routes/public";
import { metricsRoutes } from "./routes/metrics";
import { authRoutes } from "./routes/auth";
import { wellKnownRoutes } from "./routes/well-known";
import { kycRoutes } from "./routes/kyc";
import { demoRoutes } from "./routes/demo";
import { rateLimit, MemoryStore } from "./middleware/rate-limit";
import { RedisStore } from "./middleware/redis-store";
import { requestContext } from "./request-context";

const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;

async function main(): Promise<void> {
  const container = await createContainer();
  const logger = container.logger;

  const app = new Hono();
  const rateLimitStore = env.redisUrl ? new RedisStore(env.redisUrl) : new MemoryStore();
  // MUST be installed before rate-limit (and everything else) so a 429 still
  // carries a requestId, and every route handler can call getLogger(ctx).
  app.use("*", requestContext(logger));
  app.use(
    "*",
    cors({
      origin: env.corsOrigins,
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      // The session cookie is sent cross-origin (API and web app are separate
      // hosts) — credentials: true plus an explicit (non-"*") origin list is
      // required for the browser to actually attach/accept it.
      credentials: true,
    }),
  );
  app.use(
    "*",
    rateLimit({
      windowMs: env.rateLimitWindowMs,
      max: env.rateLimitMax,
      store: rateLimitStore,
      trustProxyHops: env.trustProxyHops,
    }),
  );
  const strictRateLimit = rateLimit({
    windowMs: env.rateLimitStrictWindowMs,
    max: env.rateLimitStrictMax,
    store: rateLimitStore,
    trustProxyHops: env.trustProxyHops,
  });

  app.get("/health", async (ctx) => {
    const usdcTrustline = await container.service
      .checkSellerUsdcTrustline()
      .catch(() => ({ ok: false as const, reason: "check_failed", message: "trustline preflight check failed" }));
    return ctx.json({
      ok: true,
      network: container.config.network,
      sellerWallet: container.config.sellerWallet,
      usdcTrustline,
      horizon: container.horizonStatus(),
      // Anchor health probe + circuit breaker (issue #19, 3.7) so an operator
      // can tell "the anchor is down" apart from "the API is down" without
      // tailing logs.
      anchor: container.service.healthSnapshot(),
    });
  });

  app.get("/ready", (ctx) => {
    const circuitBreakers = container.getWatcherCircuitBreakerStatus();
    const metrics = container.getWatcherMetrics();
    
    const hasOpenCircuitBreakers = circuitBreakers.some((cb) => cb.isOpen);
    
    return ctx.json({
      ok: !hasOpenCircuitBreakers,
      circuitBreakers,
      metrics: {
        accountsWatched: metrics.accountsWatched,
        tickDurationMs: metrics.tickDurationMs,
        circuitBreakersOpen: metrics.circuitBreakersOpen,
        perAccountLag: Object.fromEntries(metrics.perAccountLag),
      },
    });
  });

  app.route("/links", linkRoutes(container, strictRateLimit));
  app.route("/webhooks", webhookRoutes(container));
  app.route("/r", publicRoutes(container));

  // CORS for public receipt endpoint (accessible from any origin).
  app.use("/r/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));
  app.route("/metrics", metricsRoutes(container));
  app.route(
    "/auth",
    authRoutes({
      challenge: container.auth.challenge,
      session: container.auth.session,
      sellers: container.sellers,
      revocations: container.auth.revocations,
      secureCookie: container.auth.secureCookie,
    }),
  );
  app.route("/.well-known", wellKnownRoutes(container.auth.stellarToml));
  app.route("/seller/kyc", kycRoutes(container));
  app.route("/demo", demoRoutes(container));

  container.start();

  let server: ReturnType<typeof serve> | undefined = serve({ fetch: app.fetch, port: env.apiPort }, (info) => {
    logger.info(
      {
        event: "api.listening",
        port: info.port,
        network: container.config.network,
        horizon: container.config.horizonUrl,
        sellerWallet: container.config.sellerWallet,
        pollMs: env.pollMs,
      },
      `listening on http://localhost:${info.port}`,
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ event: "api.shutdown", signal }, "shutting down");
    container.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // Logger may not be available yet (boot-time failure); fall back to stderr.
  process.stderr.write(`[api] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
