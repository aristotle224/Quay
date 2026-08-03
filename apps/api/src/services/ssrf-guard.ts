import { promises as dns } from "node:dns";

/**
 * SSRF guard for outbound webhook URLs.
 *
 * Enforces:
 *   - HTTPS-only in production (HTTP allowed when NODE_ENV !== "production")
 *   - Hostname resolves to a public, routable IP (not RFC-1918 / loopback /
 *     link-local / ULA / IPv4-mapped IPv6)
 *   - Standard ports only (80, 443 and the scheme's default; non-standard ports
 *     are rejected)
 *   - No redirects at delivery time (caller must set redirect: "manual")
 *   - Optional WEBHOOK_HOST_ALLOWLIST for locked-down deployments
 *
 * The guard is called both at registration time and at delivery time to defeat
 * DNS-rebinding attacks (resolve once, connect to the resolved IP).
 */

/** IPv4 CIDR private/reserved ranges as [network_int, mask_bits] tuples. */
const PRIVATE_V4_RANGES: [number, number][] = [
  [0x7f000000, 8],   // 127.0.0.0/8   — loopback
  [0x0a000000, 8],   // 10.0.0.0/8    — RFC-1918
  [0xac100000, 12],  // 172.16.0.0/12 — RFC-1918
  [0xc0a80000, 16],  // 192.168.0.0/16 — RFC-1918
  [0xa9fe0000, 16],  // 169.254.0.0/16 — link-local (APIPA / metadata)
  [0x00000000, 8],   // 0.0.0.0/8     — "this" network
  [0xe0000000, 4],   // 224.0.0.0/4   — multicast
  [0xf0000000, 4],   // 240.0.0.0/4   — reserved
];

/** IPv6 address prefixes that are private/reserved (as bigint prefix + mask). */
const PRIVATE_V6_RANGES: [bigint, number][] = [
  [BigInt("0x00000000000000000000000000000001"), 128], // ::1 loopback
  [BigInt("0xfe800000000000000000000000000000"), 10],  // fe80::/10 link-local
  [BigInt("0xfc000000000000000000000000000000"), 7],   // fc00::/7  ULA
  [BigInt("0x00000000000000000000ffff00000000"), 96],  // ::ffff:0:0/96 IPv4-mapped
];

const ALLOWED_PORTS = new Set([80, 443]);

export type SsrfGuardResult =
  | { ok: true; resolvedIp: string }
  | { ok: false; reason: string };

export interface SsrfGuardOptions {
  /**
   * Comma-separated list of hostnames that bypass IP-range checks.
   * Useful for locked-down deployments where all webhooks go to a known host.
   */
  allowlist?: string[];
  /** When false, allows http:// regardless of NODE_ENV. Defaults to auto-detect. */
  productionMode?: boolean;
}

/**
 * Validate a webhook URL and resolve its hostname.
 *
 * @param rawUrl   The URL string provided by the seller.
 * @param opts     Optional allowlist / env overrides.
 * @returns        { ok: true, resolvedIp } or { ok: false, reason }.
 */
export async function guardWebhookUrl(
  rawUrl: string,
  opts: SsrfGuardOptions = {},
): Promise<SsrfGuardResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL is not valid" };
  }

  const isProduction =
    opts.productionMode !== undefined
      ? opts.productionMode
      : process.env.NODE_ENV === "production";

  // ── scheme ─────────────────────────────────────────────────────────────────
  if (isProduction && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only https:// URLs are allowed in production" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `Unsupported scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  // ── port ────────────────────────────────────────────────────────────────────
  if (parsed.port !== "") {
    const port = Number(parsed.port);
    if (!ALLOWED_PORTS.has(port)) {
      return { ok: false, reason: `Non-standard port ${port} is not allowed` };
    }
  }

  // ── allowlist bypass ────────────────────────────────────────────────────────
  if (opts.allowlist && opts.allowlist.length > 0) {
    if (opts.allowlist.includes(hostname)) {
      return { ok: true, resolvedIp: hostname }; // trusted, skip IP check
    }
  }

  // ── DNS resolution ─────────────────────────────────────────────────────────
  // Resolve ALL addresses so we can check every one.
  // dns.resolve("ANY") returns dns.AnyRecord[] (mixed record shapes without a
  // guaranteed `family` field); the `normalized` pass below safely extracts
  // only entries that carry an `address` string, so we type this loosely.
  let addresses: unknown[];
  try {
    addresses = await dns.resolve(hostname, "ANY").catch(async () => {
      // Fallback: try A then AAAA
      const v4 = await dns.resolve4(hostname).catch(() => [] as string[]);
      const v6 = await dns.resolve6(hostname).catch(() => [] as string[]);
      return [
        ...v4.map((a) => ({ address: a, family: 4 as const })),
        ...v6.map((a) => ({ address: a, family: 6 as const })),
      ];
    });
  } catch {
    return { ok: false, reason: `Could not resolve hostname: ${hostname}` };
  }

  if (!addresses || addresses.length === 0) {
    return { ok: false, reason: `No DNS records found for: ${hostname}` };
  }

  // Normalise to { address, family } — dns.resolve("ANY") can return mixed shapes
  const normalized: { address: string; family: 4 | 6 }[] = addresses.flatMap((entry) => {
    // When dns.resolve("ANY") is used the entries have .address but may be typed
    // as dns.AnyRecord without an explicit family field; extract what we need.
    if (entry !== null && typeof entry === "object" && "address" in entry && typeof (entry as Record<string, unknown>).address === "string") {
      const address = (entry as Record<string, unknown>).address as string;
      const family = address.includes(":") ? 6 : 4;
      return [{ address, family: family as 4 | 6 }];
    }
    return [];
  });

  for (const { address, family } of normalized) {
    if (family === 4) {
      const err = checkIpv4(address);
      if (err) return { ok: false, reason: err };
    } else {
      const err = checkIpv6(address);
      if (err) return { ok: false, reason: err };
    }
  }

  // Return the first resolved address so the caller can bind to it directly
  // (prevents reconnect from hitting a different IP — DNS-rebinding defence).
  if (normalized.length === 0) {
    return { ok: false, reason: `No routable address records found for: ${hostname}` };
  }
  return { ok: true, resolvedIp: normalized[0]!.address };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) | Number(octet), 0) >>> 0;
}

function checkIpv4(ip: string): string | null {
  let n: number;
  try {
    n = ipv4ToInt(ip);
  } catch {
    return `Invalid IPv4 address: ${ip}`;
  }
  for (const [network, bits] of PRIVATE_V4_RANGES) {
    const mask = bits === 32 ? 0xffffffff : ~(0xffffffff >>> bits);
    if ((n & mask) >>> 0 === (network & mask) >>> 0) {
      return `Resolved address ${ip} is in a private/reserved range`;
    }
  }
  return null;
}

function ipv6Expand(ip: string): bigint {
  // Expand :: shorthand and parse to bigint
  const halves = ip.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  const full = [...left, ...Array(missing).fill("0"), ...right];
  return full.reduce((acc, group) => (acc << BigInt(16)) | BigInt(`0x${group || "0"}`), BigInt(0));
}

function checkIpv6(ip: string): string | null {
  let n: bigint;
  try {
    n = ipv6Expand(ip);
  } catch {
    return `Invalid IPv6 address: ${ip}`;
  }
  for (const [prefix, bits] of PRIVATE_V6_RANGES) {
    const mask = bits === 128 ? ~BigInt(0) : ~((BigInt(1) << BigInt(128 - bits)) - BigInt(1));
    if ((n & mask) === (prefix & mask)) {
      return `Resolved address ${ip} is in a private/reserved IPv6 range`;
    }
  }
  return null;
}
