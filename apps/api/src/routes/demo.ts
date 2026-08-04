import { Hono } from "hono";
import type { Container } from "../services/container";
import { env } from "../env";
import { requireSeller } from "../middleware/auth";

/**
 * Demo-only routes. Only mounted when STELLAR_NETWORK=testnet so they can
 * never touch real funds on the public network.
 *
 * POST /demo/reset — deletes all rows where is_demo = true from the links table
 *   and clears their processed-tx entries so the watcher doesn't stay stuck.
 *
 * The seeding itself does NOT go through a special endpoint: the seed script
 * creates ordinary links (flagged isDemo:true) via the standard POST /links,
 * so this route only needs the reset half.
 *
 * Security: `/reset` wipes rows, so it is gated by requireSeller just like
 * link creation — an unauthenticated caller cannot wipe the demo data on a
 * shared testnet deployment. (The module-level testnet guard below is the
 * second line of defense; it 403s every path on the public network.)
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

  const auth = requireSeller({
    session: container.auth.session,
    sellers: container.sellers,
    revocations: container.auth.revocations,
  });

  /** Delete all demo-flagged links. */
  app.post("/reset", auth, async (ctx) => {
    const deleted = await container.links.deleteDemo();
    return ctx.json({ ok: true, deleted });
  });

  return app;
}
