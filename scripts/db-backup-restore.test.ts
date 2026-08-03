import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { dumpDatabase, manifestOf, restoreDatabase } from "./lib/dump";
import { encryptBackupPayload, decryptBackupPayload } from "./lib/backupCrypto";
import { bootstrap } from "../apps/api/src/db/client";
import { runBackup } from "./db-backup";
import { runRestore } from "./db-restore";

const TEST_KEY = Buffer.alloc(32, 7); // deterministic 32-byte key, test-only

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "quay-db-backup-test-"));
  process.env.BACKUP_ENCRYPTION_KEY = TEST_KEY.toString("hex");
  delete process.env.BACKUP_UPLOAD_URL;
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  delete process.env.BACKUP_ENCRYPTION_KEY;
});

async function seedSourceDb(fileUrl: string): Promise<void> {
  const client = createClient({ url: fileUrl });
  await bootstrap(client);
  await client.execute(
    "INSERT INTO sellers (id, name, wallet, created_at) VALUES ('seller_1', 'Demo Seller', 'GABC', 1000)",
  );
  await client.execute(
    `INSERT INTO links (id, reference, seller_id, destination, title, amount, asset_code, asset_issuer,
       status, tx_hash, payer, paid_amount, offramp_job_id, offramp_target_currency, offramp_status,
       expires_at, created_at, updated_at)
     VALUES ('link_1', 'ref-001', 'seller_1', 'GDEST', 'Invoice', '25.00', 'USDC', NULL,
       'paid', 'txhash1', 'GPAYER', '25.00', NULL, NULL, NULL, NULL, 1000, 1000)`,
  );
  client.close();
}

describe("dumpDatabase / restoreDatabase (lib/dump.ts)", () => {
  it("round-trips every row across all tables into a freshly-bootstrapped target", async () => {
    const sourceUrl = `file:${join(workDir, "source.db")}`;
    const targetUrl = `file:${join(workDir, "target.db")}`;
    await seedSourceDb(sourceUrl);

    const dump = await dumpDatabase(sourceUrl);
    const manifest = manifestOf(dump);
    expect(manifest.rowCounts.sellers).toBe(1);
    expect(manifest.rowCounts.links).toBe(1);

    const targetClient = createClient({ url: targetUrl });
    await bootstrap(targetClient);
    targetClient.close();

    const { rowCounts } = await restoreDatabase(targetUrl, undefined, dump);
    expect(rowCounts).toEqual(manifest.rowCounts);

    const check = createClient({ url: targetUrl });
    const result = await check.execute("SELECT reference, amount, status FROM links WHERE id = 'link_1'");
    check.close();
    // libSQL returns array-like row objects (numeric AND named keys), not real
    // Arrays, so assert on the named columns — clearer and version-stable.
    expect(result.rows[0]).toMatchObject({ reference: "ref-001", amount: "25.00", status: "paid" });
  });

  it("skips (with a warning, not an error) a table present in the dump but absent from the target", async () => {
    const sourceUrl = `file:${join(workDir, "source2.db")}`;
    const targetUrl = `file:${join(workDir, "target2.db")}`;
    await seedSourceDb(sourceUrl);
    const dump = await dumpDatabase(sourceUrl);

    // Target has no schema at all - every table in the dump is "unknown" to it.
    const { rowCounts } = await restoreDatabase(targetUrl, undefined, dump);
    expect(rowCounts).toEqual({});
  });
});

describe("encryptBackupPayload / decryptBackupPayload (lib/backupCrypto.ts)", () => {
  it("round-trips arbitrary JSON-serializable data", () => {
    const payload = { hello: "world", nested: { n: 42 }, list: [1, 2, 3] };
    const encrypted = encryptBackupPayload(payload, TEST_KEY);
    const decrypted = decryptBackupPayload(encrypted, TEST_KEY);
    expect(decrypted).toEqual(payload);
  });

  it("rejects a tampered ciphertext instead of returning corrupted data", () => {
    const encrypted = encryptBackupPayload({ a: 1 }, TEST_KEY);
    encrypted[encrypted.length - 1] ^= 0xff; // flip a bit in the ciphertext region
    expect(() => decryptBackupPayload(encrypted, TEST_KEY)).toThrow();
  });

  it("rejects decryption with the wrong key", () => {
    const encrypted = encryptBackupPayload({ a: 1 }, TEST_KEY);
    const wrongKey = Buffer.alloc(32, 9);
    expect(() => decryptBackupPayload(encrypted, wrongKey)).toThrow();
  });
});

describe("runBackup / runRestore (full CLI path)", () => {
  it("backs up a seeded database and restores it into a fresh scratch database", async () => {
    const sourceUrl = `file:${join(workDir, "prod-like.db")}`;
    const scratchUrl = `file:${join(workDir, "scratch.db")}`;
    await seedSourceDb(sourceUrl);

    const backupResult = await runBackup({
      databaseUrl: sourceUrl,
      outDir: join(workDir, "backups"),
      retentionDays: 30,
    });

    expect(backupResult.manifest.rowCounts.sellers).toBe(1);
    expect(backupResult.upload).toEqual({
      uploaded: false,
      reason: "BACKUP_UPLOAD_URL is not set - backup was written locally only.",
    });

    const writtenFile = await readFile(backupResult.filePath);
    expect(writtenFile.length).toBeGreaterThan(0);

    const restoreResult = await runRestore({
      backupFilePath: backupResult.filePath,
      targetDatabaseUrl: scratchUrl,
    });

    expect(restoreResult.verified).toBe(true);
    expect(restoreResult.restoredRowCounts).toEqual(restoreResult.manifestRowCounts);
  });
});
