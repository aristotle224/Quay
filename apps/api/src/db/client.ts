import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { encryptSecret, last4 } from "../services/secret-crypto";

export type DB = LibSQLDatabase<typeof schema>;

// CREATE TABLE IF NOT EXISTS so a fresh clone runs with no migration step.
// (drizzle-kit push can manage this instead; see drizzle.config.ts.)
const BOOTSTRAP_SQL = [
  `CREATE TABLE IF NOT EXISTS sellers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
   )`,
  // New columns (offramp_indicative_rate, offramp_rate, offramp_rate_delta) are
  // included here so fresh databases get the full schema. Existing databases are
  // handled by the ALTER TABLE statements in MIGRATION_SQL below.
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
     destination TEXT NOT NULL, muxed_id TEXT, title TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
     tx_hash TEXT, payer TEXT, paid_amount TEXT, overpaid_amount TEXT,
     offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
     offramp_indicative_rate TEXT, offramp_rate TEXT, offramp_rate_delta TEXT,
     offramp_fee_amount TEXT, offramp_fee_currency TEXT, offramp_fee_source TEXT,
     offramp_net_target_amount TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
     expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  // Cumulative payment ledger (issue 1.4) — one row per payment ever recorded
  // against a link, `tx_hash` unique so a reprocessed payment can't double-count.
  `CREATE TABLE IF NOT EXISTS link_payments (
     id TEXT PRIMARY KEY, link_id TEXT NOT NULL, tx_hash TEXT NOT NULL UNIQUE,
     payer TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS link_payments_link_id_idx ON link_payments (link_id)`,
  `CREATE TABLE IF NOT EXISTS webhooks (
     id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, url TEXT NOT NULL,
     secret_encrypted TEXT NOT NULL, secret_last4 TEXT NOT NULL,
     previous_secret_encrypted TEXT, previous_secret_last4 TEXT,
     previous_secret_expires_at INTEGER, deleted_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, link_id TEXT NOT NULL,
     event TEXT NOT NULL, status_code INTEGER, ok INTEGER NOT NULL,
     error TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_id_created_at_idx
     ON webhook_deliveries (webhook_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS offramp_quotes (
     quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
     sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
     buy_currency TEXT NOT NULL, price TEXT NOT NULL,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_jobs (
     job_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, anchor TEXT NOT NULL,
     target_currency TEXT NOT NULL, target_amount TEXT NOT NULL, rate TEXT NOT NULL,
     status TEXT NOT NULL, external_status TEXT, last_error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seller_kyc (
     seller_id TEXT PRIMARY KEY, customer_id TEXT, status TEXT NOT NULL,
     required_fields TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
     message TEXT, last_synced_at INTEGER, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS watcher_cursors (
     account TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS processed_tx (
     tx_hash TEXT PRIMARY KEY, link_id TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key TEXT NOT NULL, seller_id TEXT NOT NULL, endpoint TEXT NOT NULL,
     request_hash TEXT NOT NULL, response_status INTEGER NOT NULL,
     response_body TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (key, seller_id)
   )`,
  `CREATE TABLE IF NOT EXISTS revoked_tokens (
     jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL
   )`,
];

/**
 * Best-effort ALTER TABLE statements for existing databases that were created
 * before issue 3.5 added the three rate-telemetry columns. SQLite/libSQL throws
 * "duplicate column name" if the column already exists — we swallow that error
 * so the server can boot cleanly against both old and new schemas.
 */
const MIGRATION_SQL = [
  `ALTER TABLE links ADD COLUMN offramp_indicative_rate TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_rate TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_rate_delta TEXT`,
  `ALTER TABLE links ADD COLUMN overpaid_amount TEXT`,
];

export function createDb(databaseUrl: string, authToken?: string): { db: DB; client: Client } {
  const client = createClient({ url: databaseUrl, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

// Additive column added after the initial release. `CREATE TABLE IF NOT EXISTS`
// above won't touch an existing table, so add it out-of-band; ignore the
// "duplicate column" error on databases that already have it.
const MIGRATIONS_SQL = [
  `ALTER TABLE links ADD COLUMN muxed_id TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_fee_amount TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_fee_currency TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_fee_source TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_net_target_amount TEXT`,
  `ALTER TABLE links ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`,
];

/**
 * Upgrades a `webhooks` table created before the secret-rotation feature
 * (plaintext `secret` column, no lifecycle columns) in place. Only runs its
 * ALTERs if the old shape is actually detected, so it's a no-op on fresh
 * databases (which get the current shape directly from BOOTSTRAP_SQL above)
 * and on databases already upgraded.
 *
 * The plaintext `secret` column is intentionally left in place rather than
 * dropped — DROP COLUMN support varies across older SQLite builds, and
 * leaving an unused column is harmless. New code never reads it.
 */
async function migrateLegacyWebhooksTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(webhooks)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("secret_encrypted")) return; // fresh table, or already migrated

  for (const [name, ddl] of [
    ["secret_encrypted", "ALTER TABLE webhooks ADD COLUMN secret_encrypted TEXT"],
    ["secret_last4", "ALTER TABLE webhooks ADD COLUMN secret_last4 TEXT"],
    ["previous_secret_encrypted", "ALTER TABLE webhooks ADD COLUMN previous_secret_encrypted TEXT"],
    ["previous_secret_last4", "ALTER TABLE webhooks ADD COLUMN previous_secret_last4 TEXT"],
    ["previous_secret_expires_at", "ALTER TABLE webhooks ADD COLUMN previous_secret_expires_at INTEGER"],
    ["deleted_at", "ALTER TABLE webhooks ADD COLUMN deleted_at INTEGER"],
  ] as const) {
    if (!columns.has(name)) await client.execute(ddl);
  }

  if (columns.has("secret")) {
    const rows = await client.execute("SELECT id, secret FROM webhooks WHERE secret_encrypted IS NULL");
    for (const row of rows.rows) {
      const plaintext = String(row.secret ?? "");
      if (!plaintext) continue;
      await client.execute({
        sql: "UPDATE webhooks SET secret_encrypted = ?, secret_last4 = ? WHERE id = ?",
        args: [encryptSecret(plaintext), last4(plaintext), String(row.id)],
      });
    }
  }
}

export async function bootstrap(client: Client): Promise<void> {
  await migrateLegacyWebhooksTable(client);
  for (const sql of BOOTSTRAP_SQL) {
    try {
      await client.execute(sql);
    } catch (err) {
      // Tolerate "duplicate column" errors from the ALTER TABLE migration so the
      // bootstrap is idempotent on both fresh and pre-existing databases.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column") || msg.includes("already exists")) continue;
      throw err;
    }
  }
  for (const sql of MIGRATIONS_SQL) {
    try {
      await client.execute(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("duplicate column")) throw err;
    }
  }
}

export { schema };