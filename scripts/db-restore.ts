#!/usr/bin/env -S npx tsx
/**
 * `pnpm db:restore <backup-file> <target-database-url> [target-auth-token]`
 * (issue 8.6) - decrypts a backup and restores it into `target-database-url`.
 *
 * `target-database-url` is a required, explicit argument - this never reads
 * `DATABASE_URL` from the environment, so a stray `pnpm db:restore` can't
 * silently overwrite whatever database the ambient environment happens to
 * be pointed at. Point it at a scratch database for the quarterly drill
 * required by this issue (see `docs/RUNBOOK.md`'s restore-drill log).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDb, bootstrap } from "../apps/api/src/db/client";
import { restoreDatabase, type DatabaseDump } from "./lib/dump";
import { requireBackupEncryptionKey, decryptBackupPayload } from "./lib/backupCrypto";

export type RestoreOptions = {
  backupFilePath: string;
  targetDatabaseUrl: string;
  targetAuthToken?: string;
};

export type RestoreRunResult = {
  manifestRowCounts: Record<string, number>;
  restoredRowCounts: Record<string, number>;
  /** True only if every table's restored row count exactly matches the dump's own manifest. */
  verified: boolean;
};

export async function runRestore(options: RestoreOptions): Promise<RestoreRunResult> {
  const key = requireBackupEncryptionKey();

  const encrypted = await readFile(options.backupFilePath);
  const dump = decryptBackupPayload<DatabaseDump>(encrypted, key);

  // Recreate schema in the target before inserting - restoreDatabase() only
  // inserts into tables that already exist (see its own doc comment).
  const { client } = createDb(options.targetDatabaseUrl, options.targetAuthToken);
  await bootstrap(client);
  client.close();

  const { rowCounts: restoredRowCounts } = await restoreDatabase(
    options.targetDatabaseUrl,
    options.targetAuthToken,
    dump,
  );

  const manifestRowCounts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(dump.tables)) {
    manifestRowCounts[table] = rows.length;
  }

  const verified = Object.entries(manifestRowCounts).every(
    ([table, count]) => restoredRowCounts[table] === count,
  );

  return { manifestRowCounts, restoredRowCounts, verified };
}

function isCliInvocation(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

async function main(): Promise<void> {
  const [backupFilePath, targetDatabaseUrl, targetAuthToken] = process.argv.slice(2);
  if (!backupFilePath || !targetDatabaseUrl) {
    console.error("Usage: pnpm db:restore <backup-file> <target-database-url> [target-auth-token]");
    process.exitCode = 1;
    return;
  }

  const result = await runRestore({ backupFilePath, targetDatabaseUrl, targetAuthToken });

  console.log(`[db-restore] manifest row counts:  ${JSON.stringify(result.manifestRowCounts)}`);
  console.log(`[db-restore] restored row counts:  ${JSON.stringify(result.restoredRowCounts)}`);
  console.log(result.verified ? "[db-restore] verified: row counts match." : "[db-restore] MISMATCH - see counts above.");
  if (!result.verified) process.exitCode = 1;
}

if (isCliInvocation()) {
  main().catch((err) => {
    console.error("[db-restore] failed:", err);
    process.exitCode = 1;
  });
}
