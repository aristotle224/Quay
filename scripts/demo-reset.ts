#!/usr/bin/env tsx
/**
 * scripts/demo-reset.ts
 *
 * Removes all rows flagged as demo data (is_demo = true) from the database
 * by calling POST /demo/reset on the local API.
 *
 * Usage:
 *   pnpm demo:reset
 *   API_URL=http://localhost:8787 pnpm demo:reset
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const result: Record<string, string> = {};
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
    return result;
  }
  return {};
}

const envFile = loadEnv();
function cfg(key: string, fallback?: string): string {
  const v = process.env[key] ?? envFile[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required config: ${key}`);
  return v;
}

const API_URL = cfg("API_URL", cfg("NEXT_PUBLIC_API_URL", "http://localhost:8787"));

async function main(): Promise<void> {
  console.log(`\n▶ Resetting demo data via ${API_URL}/demo/reset…`);
  const res = await fetch(`${API_URL}/demo/reset`, { method: "POST" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST /demo/reset → ${res.status}: ${text}`);
  }
  const body = JSON.parse(text) as { ok: boolean; deleted: number };
  console.log(`  ✓ Deleted ${body.deleted} demo link(s).\n`);
}

main().catch((err) => {
  console.error("\n[demo-reset] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
