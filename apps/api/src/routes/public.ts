import { Hono } from "hono";
import type { Container } from "../services/container";

export function publicRoutes(c: Container): Hono {
  const app = new Hono();

  // Public receipt — no auth. Only returns fields safe to share with a buyer.
  app.get("/:reference", async (ctx) => {
    const link = await c.links.findByReference(ctx.req.param("reference"));
    if (!link) return ctx.json({ error: "not_found" }, 404);

    // Only show settled states; an unpaid link is not a receipt.
    const settled = new Set(["paid", "offramp_pending", "offramp_settled", "offramp_failed"]);
    if (!settled.has(link.status)) {
      return ctx.json({ error: "not_found" }, 404);
    }

    return ctx.json({
      reference: link.reference,
      title: link.title,
      amount: link.amount,
      asset: link.asset,
      status: link.status,
      txHash: link.txHash,
      payer: link.payer,
      paidAmount: link.paidAmount,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    });
  });

  return app;
}
