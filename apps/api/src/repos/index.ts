import { eq, and, inArray } from "drizzle-orm";
import type {
  CreateLinkInput,
  LinkRepository,
  PaymentLink,
  Seller,
  SellerRepository,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
  WatcherStateRepository,
  AssetRef,
} from "@checkout/core";
import type { DB } from "../db/client";
import { links, sellers, webhooks, webhookDeliveries, watcherCursors, processedTx } from "../db/schema";
import { newId } from "../services/ids";

type LinkRow = typeof links.$inferSelect;

const OPEN_STATUSES = ["active", "underpaid"];

function assetFromRow(row: LinkRow): AssetRef {
  return { code: row.assetCode, issuer: row.assetIssuer ?? null };
}

function rowToLink(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    reference: row.reference,
    sellerId: row.sellerId,
    destination: row.destination,
    title: row.title,
    amount: row.amount,
    asset: assetFromRow(row),
    status: row.status as PaymentLink["status"],
    txHash: row.txHash ?? null,
    payer: row.payer ?? null,
    paidAmount: row.paidAmount ?? null,
    offrampJobId: row.offrampJobId ?? null,
    offrampTargetCurrency: row.offrampTargetCurrency ?? null,
    offrampStatus: row.offrampStatus ?? null,
    expiresAt: row.expiresAt ?? null,
    isDemo: row.isDemo ?? false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleLinkRepository implements LinkRepository {
  constructor(private readonly db: DB) {}

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const now = Date.now();
    const row: LinkRow = {
      id: input.id,
      reference: input.reference,
      sellerId: input.sellerId,
      destination: input.destination,
      title: input.title,
      amount: input.amount,
      assetCode: input.asset.code,
      assetIssuer: input.asset.issuer,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      expiresAt: input.expiresAt,
      isDemo: input.isDemo ?? false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(links).values(row);
    return rowToLink(row);
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.id, id)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    const rows = await this.db.select().from(links).where(eq(links.reference, reference)).limit(1);
    return rows[0] ? rowToLink(rows[0]) : null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.sellerId, sellerId));
    return rows.map(rowToLink).sort((a, b) => b.createdAt - a.createdAt);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    const rows = await this.db.select().from(links).where(eq(links.status, status));
    return rows.map(rowToLink);
  }

  async activeDestinations(): Promise<string[]> {
    const rows = await this.db
      .select({ destination: links.destination })
      .from(links)
      .where(inArray(links.status, OPEN_STATUSES));
    return [...new Set(rows.map((r) => r.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    const rows = await this.db
      .select()
      .from(links)
      .where(and(eq(links.destination, destination), inArray(links.status, OPEN_STATUSES)));
    return rows.map(rowToLink);
  }

  async save(link: PaymentLink): Promise<void> {
    await this.db
      .update(links)
      .set({
        status: link.status,
        txHash: link.txHash,
        payer: link.payer,
        paidAmount: link.paidAmount,
        offrampJobId: link.offrampJobId,
        offrampTargetCurrency: link.offrampTargetCurrency,
        offrampStatus: link.offrampStatus,
        updatedAt: Date.now(),
      })
      .where(eq(links.id, link.id));
  }

  /** Delete all rows flagged as demo data. Called by `pnpm demo:reset`. */
  async deleteDemo(): Promise<number> {
    const rows = await this.db.select({ id: links.id }).from(links).where(eq(links.isDemo, true));
    if (rows.length > 0) {
      await this.db.delete(links).where(eq(links.isDemo, true));
    }
    return rows.length;
  }
}

export class DrizzleSellerRepository implements SellerRepository {
  constructor(private readonly db: DB) {}

  /** Seed (once) and return the single demo seller. */
  async ensureDefault(wallet: string, name: string): Promise<Seller> {
    const existing = await this.db.select().from(sellers).limit(1);
    if (existing[0]) {
      // keep the wallet in sync if it changed in env
      if (existing[0].wallet !== wallet) {
        await this.db.update(sellers).set({ wallet }).where(eq(sellers.id, existing[0].id));
      }
      return { ...existing[0], wallet };
    }
    const seller: Seller = { id: newId("sel"), name, wallet, createdAt: Date.now() };
    await this.db.insert(sellers).values(seller);
    return seller;
  }

  async getDefault(): Promise<Seller> {
    const rows = await this.db.select().from(sellers).limit(1);
    if (!rows[0]) throw new Error("No default seller seeded");
    return rows[0];
  }

  async findById(id: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
    return rows[0] ?? null;
  }
}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private readonly db: DB) {}

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = {
      id: newId("whk"),
      sellerId: input.sellerId,
      url: input.url,
      secret: input.secret,
      createdAt: Date.now(),
    };
    await this.db.insert(webhooks).values(hook);
    return hook;
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.db.select().from(webhooks).where(eq(webhooks.sellerId, sellerId));
  }

  async recordDelivery(d: WebhookDelivery): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: newId("whd"),
      webhookId: d.webhookId,
      linkId: d.linkId,
      event: d.event,
      statusCode: d.statusCode,
      ok: d.ok,
      error: d.error,
      createdAt: Date.now(),
    });
  }
}

export class DrizzleWatcherStateRepository implements WatcherStateRepository {
  constructor(private readonly db: DB) {}

  async getCursor(account: string): Promise<string | null> {
    const rows = await this.db
      .select()
      .from(watcherCursors)
      .where(eq(watcherCursors.account, account))
      .limit(1);
    return rows[0]?.cursor ?? null;
  }

  async setCursor(account: string, cursor: string): Promise<void> {
    await this.db
      .insert(watcherCursors)
      .values({ account, cursor, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: watcherCursors.account,
        set: { cursor, updatedAt: Date.now() },
      });
  }

  async isProcessed(txHash: string): Promise<boolean> {
    const rows = await this.db
      .select({ txHash: processedTx.txHash })
      .from(processedTx)
      .where(eq(processedTx.txHash, txHash))
      .limit(1);
    return rows.length > 0;
  }

  async markProcessed(txHash: string, linkId: string | null): Promise<void> {
    await this.db
      .insert(processedTx)
      .values({ txHash, linkId, createdAt: Date.now() })
      .onConflictDoNothing();
  }
}
