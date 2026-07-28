import { Hono } from "hono";
import type { Container } from "../services/container";
import { env } from "../env";

/**
 * Demo-only routes.  Only mounted when STELLAR_NETWORK=testnet so they can
 * never touch real funds on the public network.
 *
 * POST /demo/seed  — called internally by the seed script after it has already
 *   submitted on-chain transactions; the script marks each created link as demo
 *   by passing `isDemo: true` in the standard POST /links body, so this endpoint
 *   is mostly a guard / convenience.
 *
 * POST /demo/reset — deletes all rows where is_demo = true from the links table
 *   and clears their processed-tx entries so the watcher doesn't stay stuck.
 */
export function demoRoutes(container: Container): Hono {
  const app = new Hono();

  if (env.network !== "testnet") {
    // Return 403 for every route on the public network.
    app.all("*", (ctx) =>
      ctx.json({ error: "demo endpoints are only available on testnet" }, 403),
    );
    return app;
  }

  /** Delete all demo-flagged links. */
  app.post("/reset", async (ctx) => {
    const deleted = await container.links.deleteDemo();
    return ctx.json({ ok: true, deleted });
  });

  return app;
}
