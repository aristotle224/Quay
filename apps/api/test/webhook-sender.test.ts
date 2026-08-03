import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

// These tests point at loopback stubs, which the real SSRF guard correctly
// rejects. ssrf-guard.test.ts covers the guard itself.
const PERMISSIVE_GUARD = async () => ({ ok: true }) as const;

process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "2".repeat(64);

const { WebhookSender } = await import("../src/services/webhook-sender");
const { encryptSecret } = await import("../src/services/secret-crypto");

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function fakeRepo() {
  return { recordDelivery: vi.fn(async () => {}) } as any;
}

function baseHook(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "whk_1",
    sellerId: "slr_1",
    url: "https://receiver.example.com/hook",
    secretEncrypted: encryptSecret("current-secret-value"),
    secretLast4: "alue",
    previousSecretEncrypted: null,
    previousSecretLast4: null,
    previousSecretExpiresAt: null,
    deletedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("WebhookSender", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("signs with only the current secret when there is no active rotation", async () => {
    const repo = fakeRepo();
    const sender = new WebhookSender(repo, { guard: PERMISSIVE_GUARD });
    const hook = baseHook();

    await sender.dispatch([hook], "lnk_1", { event: "link.paid", data: { foo: "bar" } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;

    expect(headers["x-checkout-signature"]).toBe(`sha256=${sign("current-secret-value", body)}`);
    expect(headers["x-checkout-signature"]).not.toContain(",");
  });

  it("signs with both secrets while a rotation is within its overlap window", async () => {
    const repo = fakeRepo();
    const sender = new WebhookSender(repo, { guard: PERMISSIVE_GUARD });
    const hook = baseHook({
      previousSecretEncrypted: encryptSecret("old-secret-value"),
      previousSecretLast4: "alue",
      previousSecretExpiresAt: Date.now() + 60_000, // still active
    });

    await sender.dispatch([hook], "lnk_1", { event: "link.paid", data: {} });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    const body = init.body as string;

    expect(headers["x-checkout-signature"]).toBe(
      `sha256=${sign("current-secret-value", body)},sha256=${sign("old-secret-value", body)}`,
    );
  });

  it("stops sending the previous secret once its overlap window has expired", async () => {
    const repo = fakeRepo();
    const sender = new WebhookSender(repo, { guard: PERMISSIVE_GUARD });
    const hook = baseHook({
      previousSecretEncrypted: encryptSecret("old-secret-value"),
      previousSecretLast4: "alue",
      previousSecretExpiresAt: Date.now() - 1, // expired
    });

    await sender.dispatch([hook], "lnk_1", { event: "link.paid", data: {} });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-checkout-signature"]).not.toContain(",");
  });

  it("records a successful delivery outcome", async () => {
    const repo = fakeRepo();
    const sender = new WebhookSender(repo, { guard: PERMISSIVE_GUARD });
    await sender.dispatch([baseHook()], "lnk_1", { event: "link.paid", data: {} });

    expect(repo.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: "whk_1", linkId: "lnk_1", ok: true, statusCode: 200 }),
    );
  });

  it("retries transient failures and eventually records failure after exhausting attempts", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    const repo = fakeRepo();
    const sender = new WebhookSender(repo, { maxAttempts: 2, baseDelayMs: 1, guard: PERMISSIVE_GUARD });

    await sender.dispatch([baseHook()], "lnk_1", { event: "link.paid", data: {} });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(repo.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, statusCode: 500 }),
    );
  });
});
