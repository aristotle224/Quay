import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type {
  CreateLinkInput,
  KycFieldSpec,
  KycRecord,
  KycRepository,
  KycStatus,
  LinkPaymentRecord,
  LinkRepository,
  OffRampStateRepository,
  PaymentLink,
  Seller,
  SellerRepository,
  TokenRevocationRepository,
  StoredOffRampJob,
  StoredOffRampQuote,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
  WatcherStateRepository,
  AssetRef,
} from "@checkout/core";
import type { DB } from "../db/client";
import {
  links,
  linkPayments,
  sellers,
  webhooks,
  webhookDeliveries,
  watcherCursors,
  processedTx,
  offrampQuotes,
  offrampJobs,
  sellerKyc,
  revokedTokens,
} from "../db/schema";
import { fromStroops, toStroops } from "@checkout/core";
import { newId } from "../services/ids";
import { decryptPii, encryptPii } from "../crypto/pii";
import { encryptSecret, last4 } from "../services/secret-crypto";

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
    muxedId: row.muxedId ?? null,
    title: row.title,
    amount: row.amount,
    asset: assetFromRow(row),
    status: row.status as PaymentLink["status"],
    txHash: row.txHash ?? null,
    payer: row.payer ?? null,
    paidAmount: row.paidAmount ?? null,
    overpaidAmount: row.overpaidAmount ?? null,
    offrampJobId: row.offrampJobId ?? null,
    offrampTargetCurrency: row.offrampTargetCurrency ?? null,
    offrampStatus: row.offrampStatus ?? null,
    offrampIndicativeRate: row.offrampIndicativeRate ?? null,
    offrampRate: row.offrampRate ?? null,
    offrampRateDelta: row.offrampRateDelta ?? null,
    offrampFeeAmount: row.offrampFeeAmount ?? null,
    offrampFeeCurrency: row.offrampFeeCurrency ?? null,
    offrampFeeSource: row.offrampFeeSource ?? null,
    offrampNetTargetAmount: row.offrampNetTargetAmount ?? null,
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
      muxedId: input.muxedId,
      title: input.title,
      amount: input.amount,
      assetCode: input.asset.code,
      assetIssuer: input.asset.issuer,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      overpaidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      offrampIndicativeRate: null,
      offrampRate: null,
      offrampRateDelta: null,
      offrampFeeAmount: null,
      offrampFeeCurrency: null,
      offrampFeeSource: null,
      offrampNetTargetAmount: null,
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
        overpaidAmount: link.overpaidAmount,
        offrampJobId: link.offrampJobId,
        offrampTargetCurrency: link.offrampTargetCurrency,
        offrampStatus: link.offrampStatus,
        offrampIndicativeRate: link.offrampIndicativeRate,
        offrampRate: link.offrampRate,
        offrampRateDelta: link.offrampRateDelta,
        offrampFeeAmount: link.offrampFeeAmount,
        offrampFeeCurrency: link.offrampFeeCurrency,
        offrampFeeSource: link.offrampFeeSource,
        offrampNetTargetAmount: link.offrampNetTargetAmount,
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

  async recordPayment(payment: LinkPaymentRecord): Promise<void> {
    await this.db
      .insert(linkPayments)
      .values({
        id: newId("pmt"),
        linkId: payment.linkId,
        txHash: payment.txHash,
        payer: payment.payer,
        amount: payment.amount,
        assetCode: payment.asset.code,
        assetIssuer: payment.asset.issuer,
        createdAt: payment.createdAt,
      })
      .onConflictDoNothing({ target: linkPayments.txHash });
  }

  async sumPaymentsForLink(linkId: string): Promise<string> {
    const rows = await this.db
      .select({ amount: linkPayments.amount })
      .from(linkPayments)
      .where(eq(linkPayments.linkId, linkId));
    const total = rows.reduce((sum, r) => sum + toStroops(r.amount), 0n);
    return fromStroops(total);
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

  async findByWallet(wallet: string): Promise<Seller | null> {
    const rows = await this.db.select().from(sellers).where(eq(sellers.wallet, wallet)).limit(1);
    return rows[0] ?? null;
  }

  async createIfAbsent(wallet: string): Promise<Seller> {
    await this.db
      .insert(sellers)
      .values({ id: newId("sel"), name: shortWallet(wallet), wallet, createdAt: Date.now() })
      .onConflictDoNothing({ target: sellers.wallet });
    const seller = await this.findByWallet(wallet);
    if (!seller) throw new Error(`failed to create or find seller for wallet ${wallet}`);
    return seller;
  }
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

function rowToWebhook(row: typeof webhooks.$inferSelect): Webhook {
  return {
    id: row.id,
    sellerId: row.sellerId,
    url: row.url,
    secretEncrypted: row.secretEncrypted,
    secretLast4: row.secretLast4,
    previousSecretEncrypted: row.previousSecretEncrypted,
    previousSecretLast4: row.previousSecretLast4,
    previousSecretExpiresAt: row.previousSecretExpiresAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleWebhookRepository implements WebhookRepository {
  constructor(private readonly db: DB) {}

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const row = {
      id: newId("whk"),
      sellerId: input.sellerId,
      url: input.url,
      secretEncrypted: encryptSecret(input.secret),
      secretLast4: last4(input.secret),
      previousSecretEncrypted: null,
      previousSecretLast4: null,
      previousSecretExpiresAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    };
    await this.db.insert(webhooks).values(row);
    return rowToWebhook(row);
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.sellerId, sellerId), isNull(webhooks.deletedAt)));
    return rows.map(rowToWebhook);
  }

  async getById(id: string, sellerId: string, opts?: { includeDeleted?: boolean }): Promise<Webhook | null> {
    const conditions = [eq(webhooks.id, id), eq(webhooks.sellerId, sellerId)];
    if (!opts?.includeDeleted) conditions.push(isNull(webhooks.deletedAt));
    const rows = await this.db
      .select()
      .from(webhooks)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? rowToWebhook(rows[0]) : null;
  }

  async rotateSecret(id: string, sellerId: string, newSecret: string, overlapMs: number): Promise<Webhook | null> {
    const existing = await this.getById(id, sellerId);
    if (!existing) return null;

    const updated = {
      secretEncrypted: encryptSecret(newSecret),
      secretLast4: last4(newSecret),
      previousSecretEncrypted: existing.secretEncrypted,
      previousSecretLast4: existing.secretLast4,
      previousSecretExpiresAt: Date.now() + overlapMs,
    };
    await this.db
      .update(webhooks)
      .set(updated)
      .where(and(eq(webhooks.id, id), eq(webhooks.sellerId, sellerId)));

    return { ...existing, ...updated };
  }

  async softDelete(id: string, sellerId: string): Promise<boolean> {
    const result = await this.db
      .update(webhooks)
      .set({ deletedAt: Date.now() })
      .where(and(eq(webhooks.id, id), eq(webhooks.sellerId, sellerId), isNull(webhooks.deletedAt)));
    return (result.rowsAffected ?? 0) > 0;
  }

  async recordDelivery(d: Omit<WebhookDelivery, "id" | "createdAt">): Promise<void> {
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

  async listDeliveries(
    webhookId: string,
    sellerId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }> {
    // Ownership check — a merchant may only read deliveries for their own
    // webhook. Deleted webhooks are included on purpose: history must stay
    // visible after an endpoint is removed.
    const owned = await this.getById(webhookId, sellerId, { includeDeleted: true });
    if (!owned) return { deliveries: [], nextCursor: null };

    const cursorCreatedAt = opts.cursor ? decodeDeliveryCursor(opts.cursor) : null;
    const conditions = [eq(webhookDeliveries.webhookId, webhookId)];
    if (cursorCreatedAt !== null) conditions.push(lt(webhookDeliveries.createdAt, cursorCreatedAt));

    // Fetch one extra row to know whether there's a next page.
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(opts.limit + 1);

    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > opts.limit && last ? encodeDeliveryCursor(last.createdAt) : null;

    return { deliveries: page, nextCursor };
  }

  async listDeliveriesByLinkId(linkId: string): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.linkId, linkId))
      .orderBy(webhookDeliveries.createdAt);
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      linkId: r.linkId,
      event: r.event,
      statusCode: r.statusCode,
      ok: r.ok,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }
}

function encodeDeliveryCursor(createdAt: number): string {
  return Buffer.from(String(createdAt), "utf8").toString("base64url");
}

function decodeDeliveryCursor(cursor: string): number {
  const decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isFinite(decoded)) throw new Error("Invalid cursor");
  return decoded;
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

export class DrizzleTokenRevocationRepository implements TokenRevocationRepository {
  constructor(private readonly db: DB) {}

  async revoke(jti: string, expiresAt: number): Promise<void> {
    await this.db
      .insert(revokedTokens)
      .values({ jti, expiresAt, revokedAt: Date.now() })
      .onConflictDoNothing();
  }

  async isRevoked(jti: string): Promise<boolean> {
    const rows = await this.db.select({ jti: revokedTokens.jti }).from(revokedTokens).where(eq(revokedTokens.jti, jti)).limit(1);
    return rows.length > 0;
  }

  async sweepExpired(now: number): Promise<void> {
    await this.db.delete(revokedTokens).where(lt(revokedTokens.expiresAt, now));
  }
}

type OffRampQuoteRow = typeof offrampQuotes.$inferSelect;
type OffRampJobRow = typeof offrampJobs.$inferSelect;

function rowToQuote(row: OffRampQuoteRow): StoredOffRampQuote {
  return {
    quoteId: row.quoteId,
    linkId: row.linkId,
    sellAsset: { code: row.sellAssetCode, issuer: row.sellAssetIssuer ?? null },
    sellAmount: row.sellAmount,
    buyCurrency: row.buyCurrency,
    price: row.price,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function rowToJob(row: OffRampJobRow): StoredOffRampJob {
  return {
    jobId: row.jobId,
    linkId: row.linkId,
    anchor: row.anchor,
    targetCurrency: row.targetCurrency,
    targetAmount: row.targetAmount,
    rate: row.rate,
    status: row.status as StoredOffRampJob["status"],
    externalStatus: row.externalStatus ?? null,
    lastError: row.lastError ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Off-ramp quotes and jobs — money-adjacent state that must survive a restart. */
export class DrizzleOffRampStateRepository implements OffRampStateRepository {
  constructor(private readonly db: DB) {}

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    await this.db.insert(offrampQuotes).values({
      quoteId: quote.quoteId,
      linkId: quote.linkId,
      sellAssetCode: quote.sellAsset.code,
      sellAssetIssuer: quote.sellAsset.issuer,
      sellAmount: quote.sellAmount,
      buyCurrency: quote.buyCurrency,
      price: quote.price,
      expiresAt: quote.expiresAt,
      createdAt: quote.createdAt,
    });
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    const rows = await this.db.select().from(offrampQuotes).where(eq(offrampQuotes.quoteId, quoteId)).limit(1);
    return rows[0] ? rowToQuote(rows[0]) : null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    await this.db.insert(offrampJobs).values({
      jobId: job.jobId,
      linkId: job.linkId,
      anchor: job.anchor,
      targetCurrency: job.targetCurrency,
      targetAmount: job.targetAmount,
      rate: job.rate,
      status: job.status,
      externalStatus: job.externalStatus,
      lastError: job.lastError,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    const rows = await this.db.select().from(offrampJobs).where(eq(offrampJobs.jobId, jobId)).limit(1);
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    await this.db
      .update(offrampJobs)
      .set({ ...patch, updatedAt: Date.now() })
      .where(eq(offrampJobs.jobId, jobId));
  }
}

type SellerKycRow = typeof sellerKyc.$inferSelect;

/**
 * Seller-level SEP-12 KYC state. `fieldsEncrypted` is the seller's submitted
 * PII (name, email, address, ...) — encrypted with `piiKey` before it ever
 * touches the database, decrypted only in-process when read back.
 */
export class DrizzleKycRepository implements KycRepository {
  constructor(
    private readonly db: DB,
    private readonly piiKey: Buffer,
  ) {}

  private rowToRecord(row: SellerKycRow): KycRecord {
    return {
      sellerId: row.sellerId,
      customerId: row.customerId ?? null,
      status: row.status as KycStatus,
      requiredFields: JSON.parse(row.requiredFields) as KycFieldSpec[],
      providedFields: JSON.parse(decryptPii(row.fieldsEncrypted, this.piiKey)) as Record<string, string>,
      message: row.message ?? null,
      lastSyncedAt: row.lastSyncedAt ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async get(sellerId: string): Promise<KycRecord | null> {
    const rows = await this.db.select().from(sellerKyc).where(eq(sellerKyc.sellerId, sellerId)).limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : null;
  }

  async save(record: KycRecord): Promise<void> {
    const row = {
      sellerId: record.sellerId,
      customerId: record.customerId,
      status: record.status,
      requiredFields: JSON.stringify(record.requiredFields),
      fieldsEncrypted: encryptPii(JSON.stringify(record.providedFields), this.piiKey),
      message: record.message,
      lastSyncedAt: record.lastSyncedAt,
      updatedAt: record.updatedAt,
    };
    await this.db
      .insert(sellerKyc)
      .values(row)
      .onConflictDoUpdate({ target: sellerKyc.sellerId, set: row });
  }
}