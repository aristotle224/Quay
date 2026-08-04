import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal dependency-free .env loader for the root scripts. Reads the first
 * .env found at ./ (cwd) or ../../ (repo root), without overwriting vars that
 * are already set in the process environment.
 */
export function loadEnvFile(): Record<string, string> {
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

/** Resolves a config value from the process env, then the .env file. */
export function envValue(envFile: Record<string, string>, key: string, fallback?: string): string {
  const v = process.env[key] ?? envFile[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required config: ${key}`);
  return v;
}
