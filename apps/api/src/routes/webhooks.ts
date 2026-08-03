import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { registerWebhookSchema, listWebhookDeliveriesQuerySchema } from "@checkout/core";
import type { PublicWebhook, Webhook } from "@checkout/core";
import type { Container } from "../services/container";
import { requireSeller, type AuthedVariables } from "../middleware/auth";
import { guardWebhookUrl } from "../services/ssrf-guard";

const HOST_ALLOWLIST = process.env.WEBHOOK_HOST_ALLOWLIST
  ? process.env.WEBHOOK_HOST_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

/** How long the previous secret keeps signing deliveries after a rotation. */
export const SECRET_ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

function generateSecret(): string {
  return randomBytes(24).toString("hex");
}

/** Strips secret material before a webhook is ever serialized in a response. */
function toPublic(h: Webhook): PublicWebhook {
  const { secretEncrypted, previousSecretEncrypted, ...safe } = h;
  return safe;
}

export function webhookRoutes(c: Container): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();
  app.use("*", requireSeller({ session: c.auth.session, sellers: c.sellers, revocations: c.auth.revocations }));

  // Register a webhook. The secret is returned ONCE — store it to verify signatures.
  app.post("/", async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      body = {};
    }
    const parsed = registerWebhookSchema.safeParse(body);
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    // SSRF guard: validate the URL and resolve the hostname before storing.
    const guard = await (c.webhookGuard ?? ((u: string) => guardWebhookUrl(u, { allowlist: HOST_ALLOWLIST })))(
      parsed.data.url,
    );
    if (!guard.ok) {
      return ctx.json({ error: "invalid_webhook_url", reason: guard.reason }, 422);
    }

    const seller = ctx.get("seller");
    const secret = generateSecret();
    const hook = await c.webhooks.create({ sellerId: seller.id, url: parsed.data.url, secret });
    return ctx.json({ ...toPublic(hook), secret }, 201);
  });

  // List registered webhooks (secrets are not returned; deleted ones are excluded).
  app.get("/", async (ctx) => {
    const seller = ctx.get("seller");
    const hooks = await c.webhooks.listBySeller(seller.id);
    return ctx.json({ webhooks: hooks.map(toPublic) });
  });

  // Remove a webhook. Soft delete — delivery history stays visible afterward.
  app.delete("/:id", async (ctx) => {
    const seller = await c.sellers.getDefault();
    const deleted = await c.webhooks.softDelete(ctx.req.param("id"), seller.id);
    if (!deleted) return ctx.json({ error: "not_found" }, 404);
    return ctx.body(null, 204);
  });

  // Rotate a webhook's signing secret. The new secret is returned ONCE, exactly
  // like at creation. The old secret keeps signing deliveries for 24h (see
  // WebhookSender) so an in-flight deploy of the new secret doesn't drop events.
  app.post("/:id/rotate-secret", async (ctx) => {
    const seller = await c.sellers.getDefault();
    const secret = generateSecret();
    const hook = await c.webhooks.rotateSecret(ctx.req.param("id"), seller.id, secret, SECRET_ROTATION_OVERLAP_MS);
    if (!hook) return ctx.json({ error: "not_found" }, 404);
    return ctx.json({ ...toPublic(hook), secret });
  });

  // Paginated delivery history for one webhook (visible even after it's deleted).
  app.get("/:id/deliveries", async (ctx) => {
    const seller = await c.sellers.getDefault();
    const parsed = listWebhookDeliveriesQuerySchema.safeParse({
      limit: ctx.req.query("limit"),
      cursor: ctx.req.query("cursor"),
    });
    if (!parsed.success) return ctx.json({ error: "invalid_query", issues: parsed.error.issues }, 400);

    const owned = await c.webhooks.getById(ctx.req.param("id"), seller.id, { includeDeleted: true });
    if (!owned) return ctx.json({ error: "not_found" }, 404);

    const { deliveries, nextCursor } = await c.webhooks.listDeliveries(owned.id, seller.id, parsed.data);
    return ctx.json({ deliveries, nextCursor });
  });

  return app;
}
