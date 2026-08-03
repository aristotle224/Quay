#!/usr/bin/env -S npx tsx
/**
 * `pnpm db:backup` (issue 8.6) - dumps every table to a single timestamped,
 * encrypted file, optionally pushes it to object storage, and prunes local
 * copies past the retention window.
 *
 * RPO note: this script only runs when invoked (manually, or by the nightly
 * scheduled job in `.github/workflows/db-backup.yml`). A nightly cadence
 * means the honest worst-case RPO is **up to 24 hours** of data loss, not
 * continuous protection - see `docs/RUNBOOK.md`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDatabase, manifestOf } from "./lib/dump";
import { requireBackupEncryptionKey, encryptBackupPayload } from "./lib/backupCrypto";
import { uploadBackup, pruneLocalBackups } from "./lib/objectStorage";

export type BackupRunResult = {
  filePath: string;
  manifest: ReturnType<typeof manifestOf>;
  upload: Awaited<ReturnType<typeof uploadBackup>>;
  pruned: string[];
};

export type BackupOptions = {
  databaseUrl: string;
  authToken?: string;
  outDir: string;
  retentionDays: number;
};

export async function runBackup(options: BackupOptions): Promise<BackupRunResult> {
  const key = requireBackupEncryptionKey();

  const dump = await dumpDatabase(options.databaseUrl, options.authToken);
  const manifest = manifestOf(dump);
  const encrypted = encryptBackupPayload(dump, key);

  await mkdir(options.outDir, { recursive: true });
  const timestamp = dump.createdAt.replace(/[:.]/g, "-");
  const filePath = join(options.outDir, `backup-${timestamp}.db.json.enc`);
  await writeFile(filePath, encrypted);

  const upload = await uploadBackup(encrypted);
  const pruned = await pruneLocalBackups(options.outDir, options.retentionDays);

  return { filePath, manifest, upload, pruned };
}

function isCliInvocation(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run a backup.");
  }

  const result = await runBackup({
    databaseUrl,
    authToken: process.env.DATABASE_AUTH_TOKEN,
    outDir: process.env.BACKUP_OUT_DIR ?? "backups",
    retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? "30"),
  });

  console.log(`[db-backup] wrote ${result.filePath}`);
  console.log(`[db-backup] row counts: ${JSON.stringify(result.manifest.rowCounts)}`);
  console.log(
    result.upload.uploaded
      ? "[db-backup] uploaded to BACKUP_UPLOAD_URL"
      : `[db-backup] not uploaded - ${result.upload.reason}`,
  );
  if (result.pruned.length > 0) {
    console.log(`[db-backup] pruned ${result.pruned.length} backup(s) past retention: ${result.pruned.join(", ")}`);
  }
}

if (isCliInvocation()) {
  main().catch((err) => {
    console.error("[db-backup] failed:", err);
    process.exitCode = 1;
  });
}
