import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Generic HTTP PUT upload - works against a pre-signed S3/R2/B2 URL (the
 * common case for a small nightly job with no cloud SDK dependency) or any
 * authenticated PUT endpoint. No AWS/GCS SDK is added here: this repo's
 * existing scripts and packages are dependency-light by convention, and a
 * presigned-URL PUT covers the common object-storage providers without one.
 *
 * `BACKUP_UPLOAD_URL` unset means "no object storage configured" - the
 * backup is still written locally and reported as such, never silently
 * treated as "uploaded".
 */
export type UploadResult = { uploaded: true } | { uploaded: false; reason: string };

export async function uploadBackup(fileBuffer: Buffer): Promise<UploadResult> {
  const uploadUrl = process.env.BACKUP_UPLOAD_URL;
  if (!uploadUrl) {
    return { uploaded: false, reason: "BACKUP_UPLOAD_URL is not set - backup was written locally only." };
  }

  const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
  const authHeader = process.env.BACKUP_UPLOAD_AUTH_HEADER; // e.g. "Authorization: Bearer <token>"
  if (authHeader) {
    const sep = authHeader.indexOf(":");
    if (sep > 0) {
      headers[authHeader.slice(0, sep).trim()] = authHeader.slice(sep + 1).trim();
    }
  }

  const res = await fetch(uploadUrl, { method: "PUT", headers, body: fileBuffer });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Backup upload to BACKUP_UPLOAD_URL failed: HTTP ${res.status} ${body}`);
  }
  return { uploaded: true };
}

/**
 * Deletes locally-written backup files older than `retentionDays`. This is
 * the *local* retention story - remote/object-storage retention should be
 * configured via the bucket's own lifecycle policy (e.g. an S3 lifecycle
 * rule), not hand-rolled remote deletion against an unknown provider's API
 * from this script.
 */
export async function pruneLocalBackups(dir: string, retentionDays: number): Promise<string[]> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return removed; // directory doesn't exist yet - nothing to prune
  }

  for (const entry of entries) {
    if (!entry.endsWith(".db.json.enc")) continue;
    const filePath = join(dir, entry);
    const info = await stat(filePath);
    if (info.mtimeMs < cutoff) {
      await unlink(filePath);
      removed.push(filePath);
    }
  }
  return removed;
}
