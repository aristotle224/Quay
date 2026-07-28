import { describe, it, expect } from "vitest";
import { matchPayment, type NormalizedPayment } from "../src/matching/match-payment";
import type { PaymentLink } from "../src/domain/payment-link";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function link(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "ref_1",
    sellerId: "s_1",
    destination: DEST,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "active",
    txHash: null,
    payer: null,
    paidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    expiresAt: null,
    isDemo: false,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function payment(over: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    txHash: "tx1",
    pagingToken: "1",
    from: "GBUYER",
    to: DEST,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    memo: "ref_1",
    memoType: "text",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const byRef = (l: PaymentLink) => (ref: string) => (ref === l.reference ? l : undefined);

describe("matchPayment", () => {
  it("marks exact payment as paid", () => {
    const l = link();
    const r = matchPayment(payment(), byRef(l));
    expect(r.kind).toBe("paid");
    if (r.kind === "paid") expect(r.overpaid).toBe(false);
  });

  it("flags overpayment as paid+overpaid", () => {
    const l = link();
    const r = matchPayment(payment({ amount: "12" }), byRef(l));
    expect(r.kind).toBe("paid");
    if (r.kind === "paid") expect(r.overpaid).toBe(true);
  });

  it("flags underpayment", () => {
    const l = link();
    const r = matchPayment(payment({ amount: "9.5" }), byRef(l));
    expect(r.kind).toBe("underpaid");
  });

  it("rejects wrong asset even if memo matches", () => {
    const l = link();
    const r = matchPayment(payment({ asset: { code: "XLM", issuer: null } }), byRef(l));
    expect(r.kind).toBe("asset_mismatch");
  });

  it("returns no_memo when memo missing", () => {
    const l = link();
    const r = matchPayment(payment({ memo: null, memoType: "none" }), byRef(l));
    expect(r.kind).toBe("no_memo");
  });

  it("returns unknown_reference for an unrecognized memo", () => {
    const l = link();
    const r = matchPayment(payment({ memo: "ref_other" }), byRef(l));
    expect(r.kind).toBe("unknown_reference");
  });

  it("rejects a payment addressed to a different destination", () => {
    const l = link();
    const r = matchPayment(payment({ to: "GSOMEONEELSE" }), byRef(l));
    expect(r.kind).toBe("unknown_reference");
  });
});
