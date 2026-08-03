import type { KycFieldSpec, KycStatus, PaymentLink, PaymentRequest } from "@checkout/core";

export type { PaymentLink, PaymentRequest };

export interface LinkWithRequest {
  link: PaymentLink;
  request: PaymentRequest;
}

/** A webhook delivery record for timeline display. */
export interface WebhookDelivery {
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

export interface LinkDetail {
  link: PaymentLink;
  request: PaymentRequest;
  deliveries: WebhookDelivery[];
}

/** Fields exposed on the public receipt — never includes seller PII. */
export interface PublicReceipt {
  reference: string;
  title: string;
  amount: string;
  asset: { code: string; issuer: string | null };
  status: string;
  txHash: string | null;
  payer: string | null;
  paidAmount: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KycView {
  status: KycStatus;
  requiredFields: KycFieldSpec[];
  providedFields: Record<string, string>;
  message: string | null;
  lastSyncedAt: number | null;
}

// Browser calls go to NEXT_PUBLIC_API_URL; server-side calls fall back to API_URL.
const BROWSER_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function apiBase(): string {
  if (typeof window === "undefined") {
    return process.env.API_URL ?? BROWSER_BASE;
  }
  return BROWSER_BASE;
}

// Session token lives ONLY in memory for the lifetime of the page — never
// localStorage/sessionStorage (a persistent, JS-readable store is exactly what
// an XSS payload would go looking for). It's lost on a hard refresh; the
// httpOnly `session` cookie the API also sets is what survives that (sent
// automatically via `credentials: "include"`, never readable by this code).
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

// ── Typed error envelope ────────────────────────────────────────────────────

/** Machine-readable error codes the API can return in its `error` field. */
export type ApiErrorCode =
  | "not_found"
  | "invalid_body"
  | "conflict"
  | "kyc_required" // seller's SEP-12 KYC isn't ACCEPTED yet — see `missingFields`
  | "destination_cannot_receive" // seller wallet can't receive the asset — see `details.trustlineUri`
  | "unreachable" // synthetic — fetch itself threw (DNS / network down)
  | "server_error"; // 5xx or unexpected non-JSON response

/** Structured error thrown by http() so callers can branch on code. */
export class CheckoutError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    detail: string,
    /** Set when `code === "kyc_required"` and the API named specific missing fields. */
    readonly missingFields?: string[],
    /** Everything else in the error body — e.g. `reason`, `trustlineUri`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code} (${status}): ${detail}`);
    this.name = "CheckoutError";
  }
}

/** Map an error code to copy suitable for a seller-facing dashboard. */
export function describeError(err: CheckoutError): string {
  switch (err.code) {
    case "not_found":
      return "This link no longer exists. It may have been removed or the id is wrong.";
    case "invalid_body":
      return "The data sent to the server was invalid. Check your inputs and try again.";
    case "conflict":
      return "This action cannot be completed right now. The link may be in an unexpected state. Try refreshing.";
    case "kyc_required":
      return "Identity verification is required before you can cash out. See the panel above.";
    case "destination_cannot_receive":
      return "Your wallet can't receive this asset yet. Add the trustline and try again.";
    case "unreachable":
      return "We can't reach the payment service right now. Check your connection and try again.";
    case "server_error":
      return "Something went wrong on the server. Please try again in a moment.";
    default:
      return "An unexpected error occurred. Please try again.";
  }
}

// ── HTTP client ─────────────────────────────────────────────────────────────

/**
 * Thin fetch wrapper.
 *
 * - 2xx → parse JSON and return `T` (204 → `undefined`, e.g. DELETE /webhooks/:id)
 * - 4xx/5xx → extract `{ error: string }` envelope and throw `CheckoutError`
 * - Network failure → throw `CheckoutError` with code `"unreachable"`
 */
async function http<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  if (init?.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "include", // send the httpOnly session cookie cross-origin
    });
  } catch {
    throw new CheckoutError("unreachable", 0, "Network request failed");
  }

  if (!res.ok) {
    // The session is no longer good for anything — drop it so the UI can
    // re-authenticate rather than retrying with a dead token.
    if (res.status === 401) setSessionToken(null);
    const raw = await res.text().catch(() => "");
    const body = parseJsonObject(raw) ?? {};
    const { error, missingFields: rawMissing, message, ...details } = body;
    const apiCode = typeof error === "string" ? error : undefined;
    const missingFields = Array.isArray(rawMissing) ? (rawMissing as string[]) : undefined;
    const code: ApiErrorCode =
      res.status >= 500
        ? "server_error"
        : res.status === 409
          ? "conflict"
          : apiCode === "not_found"
            ? "not_found"
            : apiCode === "invalid_body"
              ? "invalid_body"
              : apiCode === "kyc_required"
                ? "kyc_required"
                : apiCode === "destination_cannot_receive"
                  ? "destination_cannot_receive"
                  : "server_error";
    const detail = typeof message === "string" ? message : (apiCode ?? res.statusText);
    throw new CheckoutError(code, res.status, detail, missingFields, details);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** One anchor-advertised indicative price (issue 3.5). Never a firm quote. */
export interface IndicativePrice {
  targetCurrency: string;
  price: string;
  deliveryMethods: string[];
}

export interface OfframpPreview {
  indicative: true;
  prices: IndicativePrice[];
  sourceAmount: string;
}

export interface CreateLinkInput {
  title: string;
  amount: string;
  assetCode: "USDC" | "XLM";
  expiresInMinutes?: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  linkId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  createdAt: number;
}

export interface Webhook {
  id: string;
  url: string;
  secretLast4: string;
  previousSecretLast4: string | null;
  previousSecretExpiresAt: number | null;
  deletedAt: number | null;
  createdAt: number;
}

export interface AuthChallenge {
  transaction: string;
  network_passphrase: string;
}

export type UsdcTrustlineStatus =
  | { ok: true }
  | { ok: false; reason: string; message: string; trustlineUri?: string };

export interface HealthResponse {
  ok: boolean;
  network: string;
  sellerWallet: string;
  usdcTrustline: UsdcTrustlineStatus;
}

export const api = {
  createLink: (input: CreateLinkInput, idempotencyKey?: string) =>
    http<LinkWithRequest>("/links", { method: "POST", body: JSON.stringify(input), idempotencyKey }),

  listLinks: () => http<{ links: PaymentLink[] }>("/links"),

  getLink: (id: string) => http<LinkWithRequest>(`/links/${id}`),

  getDetail: (id: string) => http<LinkDetail>(`/links/${id}/detail`),

  getReceipt: (reference: string) => http<PublicReceipt>(`/r/${reference}`),

  /** Indicative SEP-38 prices for a paid link — no firm quote is consumed. */
  getOfframpPreview: (id: string, currency?: string) =>
    http<OfframpPreview>(
      `/links/${id}/offramp-preview${currency ? `?currency=${encodeURIComponent(currency)}` : ""}`,
    ),

  health: () => http<HealthResponse>("/health"),

  cashOut: (
    id: string,
    targetCurrency: string,
    payoutFields: Record<string, string> = {},
    idempotencyKey?: string,
  ) =>
    http<{ job: { jobId: string; status: string; targetAmount: string; targetCurrency: string } }>(
      `/links/${id}/cash-out`,
      { method: "POST", body: JSON.stringify({ targetCurrency, payoutFields }), idempotencyKey },
    ),

  exportCsv: async (from?: string, to?: string): Promise<Blob> => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    const res = await fetch(`${apiBase()}/links/export/csv${qs ? `?${qs}` : ""}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.blob();
  },
  // Wallet-native login (SEP-10): getAuthChallenge() -> sign with the wallet ->
  // submitAuthChallenge() -> setSessionToken(token) on success.
  getAuthChallenge: (account: string) => http<AuthChallenge>(`/auth?account=${encodeURIComponent(account)}`),

  submitAuthChallenge: (transaction: string) =>
    http<{ token: string; expiresAt: number }>("/auth", { method: "POST", body: JSON.stringify({ transaction }) }).then((res) => {
      setSessionToken(res.token);
      return res;
    }),

  logout: () => http<{ ok: true }>("/auth/logout", { method: "POST" }).finally(() => setSessionToken(null)),
  getKyc: () => http<KycView>("/seller/kyc"),

  submitKyc: (fields: Record<string, string>) =>
    http<KycView>("/seller/kyc", { method: "PUT", body: JSON.stringify(fields) }),

  listWebhooks: () => http<{ webhooks: Webhook[] }>("/webhooks"),

  createWebhook: (url: string) =>
    http<Webhook & { secret: string }>("/webhooks", { method: "POST", body: JSON.stringify({ url }) }),

  deleteWebhook: (id: string) => http<void>(`/webhooks/${id}`, { method: "DELETE" }),

  rotateWebhookSecret: (id: string) =>
    http<Webhook & { secret: string }>(`/webhooks/${id}/rotate-secret`, { method: "POST" }),

  listWebhookDeliveries: (id: string, opts: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString();
    return http<{ deliveries: WebhookDelivery[]; nextCursor: string | null }>(
      `/webhooks/${id}/deliveries${qs ? `?${qs}` : ""}`,
    );
  },
};
