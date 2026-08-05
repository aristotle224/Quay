import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const sellers = sqliteTable("sellers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  wallet: text("wallet").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const links = sqliteTable("links", {
  id: text("id").primaryKey(),
  reference: text("reference").notNull().unique(),
  sellerId: text("seller_id").notNull(),
  destination: text("destination").notNull(),
  muxedId: text("muxed_id"), // SEP-23 correlation id; null in memo mode (the default)
  title: text("title").notNull(),
  amount: text("amount").notNull(),
  assetCode: text("asset_code").notNull(),
  assetIssuer: text("asset_issuer"), // null = native XLM
  status: text("status").notNull(),
  txHash: text("tx_hash"),
  payer: text("payer"),
  paidAmount: text("paid_amount"),
  /** Surplus once cumulative payments exceed the requested amount (issue 1.4). */
  overpaidAmount: text("overpaid_amount"),
  offrampJobId: text("offramp_job_id"),
  offrampTargetCurrency: text("offramp_target_currency"),
  offrampStatus: text("offramp_status"),
  /** Indicative rate captured at preview time (issue 3.5 telemetry). */
  offrampIndicativeRate: text("offramp_indicative_rate"),
  /** Firm rate from the SEP-38 POST /quote (issue 3.5 telemetry). */
  offrampRate: text("offramp_rate"),
  /** Absolute delta: firm − indicative (issue 3.5 telemetry). */
  offrampRateDelta: text("offramp_rate_delta"),
  /** Anchor fee quoted at cash-out time (issue 1.5), so the receipt can reproduce it. */
  offrampFeeAmount: text("offramp_fee_amount"),
  offrampFeeCurrency: text("offramp_fee_currency"),
  offrampFeeSource: text("offramp_fee_source"), // "anchor" | "estimated"
  offrampNetTargetAmount: text("offramp_net_target_amount"),
  expiresAt: integer("expires_at"),
  /** Set to 1 for rows created by the demo seed script. Shown as a badge in the
   *  dashboard and cleaned up by `pnpm demo:reset` / POST /demo/reset. */
  isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Authoritative ledger of every payment recorded against a link — cumulative
// accounting (issue 1.4) sums these rather than trusting a single payment.
// `txHash` is unique so a reprocessed payment can never double-count.
export const linkPayments = sqliteTable("link_payments", {
  id: text("id").primaryKey(),
  linkId: text("link_id").notNull(),
  txHash: text("tx_hash").notNull().unique(),
  payer: text("payer").notNull(),
  amount: text("amount").notNull(),
  assetCode: text("asset_code").notNull(),
  assetIssuer: text("asset_issuer"), // null = native XLM
  createdAt: integer("created_at").notNull(),
});

export const webhooks = sqliteTable("webhooks", {
  id: text("id").primaryKey(),
  sellerId: text("seller_id").notNull(),
  url: text("url").notNull(),
  secretEncrypted: text("secret_encrypted").notNull(),
  secretLast4: text("secret_last4").notNull(),
  previousSecretEncrypted: text("previous_secret_encrypted"),
  previousSecretLast4: text("previous_secret_last4"),
  previousSecretExpiresAt: integer("previous_secret_expires_at"),
  deletedAt: integer("deleted_at"),
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

export const offrampQuotes = sqliteTable("offramp_quotes", {
  quoteId: text("quote_id").primaryKey(),
  linkId: text("link_id").notNull(),
  sellAssetCode: text("sell_asset_code").notNull(),
  sellAssetIssuer: text("sell_asset_issuer"), // null = native XLM
  sellAmount: text("sell_amount").notNull(),
  buyCurrency: text("buy_currency").notNull(),
  price: text("price").notNull(),
  expiresAt: integer("expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const offrampJobs = sqliteTable("offramp_jobs", {
  jobId: text("job_id").primaryKey(),
  linkId: text("link_id").notNull(),
  anchor: text("anchor").notNull(),
  targetCurrency: text("target_currency").notNull(),
  targetAmount: text("target_amount").notNull(),
  rate: text("rate").notNull(),
  status: text("status").notNull(),
  externalStatus: text("external_status"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Keyed by seller (never by link) — identity is submitted once and reused
// across every link. `fieldsEncrypted` is the only PII column: an AES-256-GCM
// blob of the seller's submitted field values, opaque without KYC_ENCRYPTION_KEY.
export const sellerKyc = sqliteTable("seller_kyc", {
  sellerId: text("seller_id").primaryKey(),
  customerId: text("customer_id"),
  status: text("status").notNull(),
  requiredFields: text("required_fields").notNull(), // JSON KycFieldSpec[] — not PII, just schema metadata
  fieldsEncrypted: text("fields_encrypted").notNull(), // AES-256-GCM blob of Record<string,string>
  message: text("message"),
  lastSyncedAt: integer("last_synced_at"),
  updatedAt: integer("updated_at").notNull(),
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

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").notNull(),
  sellerId: text("seller_id").notNull(),
  endpoint: text("endpoint").notNull(),
  requestHash: text("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: integer("created_at").notNull(),
});

// Logout / compromise revocation for session JWTs, keyed by the token's own
// `jti`. `expiresAt` mirrors the token's own `exp` — once a token would fail
// verification on expiry alone, its revocation row is dead weight and gets
// swept.
export const revokedTokens = sqliteTable("revoked_tokens", {
  jti: text("jti").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at").notNull(),
});