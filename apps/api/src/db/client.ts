import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type DB = LibSQLDatabase<typeof schema>;

// CREATE TABLE IF NOT EXISTS so a fresh clone runs with no migration step.
// (drizzle-kit push can manage this instead; see drizzle.config.ts.)
const BOOTSTRAP_SQL = [
  `CREATE TABLE IF NOT EXISTS sellers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
     destination TEXT NOT NULL, title TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
     tx_hash TEXT, payer TEXT, paid_amount TEXT,
     offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
     expires_at INTEGER, is_demo INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  // Idempotent migration for databases created before the is_demo column was added.
  `ALTER TABLE links ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS webhooks (
     id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, url TEXT NOT NULL,
     secret TEXT NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, link_id TEXT NOT NULL,
     event TEXT NOT NULL, status_code INTEGER, ok INTEGER NOT NULL,
     error TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS watcher_cursors (
     account TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS processed_tx (
     tx_hash TEXT PRIMARY KEY, link_id TEXT, created_at INTEGER NOT NULL
   )`,
];

export function createDb(databaseUrl: string, authToken?: string): { db: DB; client: Client } {
  const client = createClient({ url: databaseUrl, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

export async function bootstrap(client: Client): Promise<void> {
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
}

export { schema };
