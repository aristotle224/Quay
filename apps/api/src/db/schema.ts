import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sellers = sqliteTable("sellers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  wallet: text("wallet").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const links = sqliteTable("links", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  sellerId: text("seller_id").notNull(),
  destination: text("destination").notNull(),
  title: text("title").notNull(),
  amount: text("amount").notNull(),
  assetCode: text("asset_code").notNull(),
  assetIssuer: text("asset_issuer"), // null = native XLM
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  payer: text("payer"),
  paidAmount: text("paid_amount"),
  offrampJobId: text("offramp_job_id"),
  offrampTargetCurrency: text("offramp_target_currency"),
  offrampStatus: text("offramp_status"),
  expiresAt: integer("expires_at"),
  /** Set to 1 for rows created by the demo seed script. Shown as a badge in the
   *  dashboard and cleaned up by `pnpm demo:reset` / POST /demo/reset. */
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  webhookId: text("webhook_id").notNull(),
  linkId: text("link_id").notNull(),
  event: text("event").notNull(),
  statusCode: integer("status_code"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});

export const watcherCursors = sqliteTable("watcher_cursors", {
  account: text("account").primaryKey(),
  cursor: text("cursor").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const processedTx = sqliteTable("processed_tx", {
  txHash: text("tx_hash").primaryKey(),
  linkId: text("link_id"),
  createdAt: integer("created_at").notNull(),
});
