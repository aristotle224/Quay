import { describe, expect, it } from "vitest";
import { matchPayment, type NormalizedPayment, type RailPort } from "@checkout/core";
import { LinkService } from "../src/services/link-service";
import {
  AlwaysAcceptedKyc,
  FakeLinkRepository,
  FakeOffRampStateRepository,
  FakeWebhookRepository,
  ScriptedOffRamp,
  makeLink,
} from "./fakes";
import type { StellarConfig } from "@checkout/stellar";

const STELLAR: StellarConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  usdcIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const UNUSED_RAIL: RailPort = {
  async assertCanReceive() {},
  buildRequest() {
    throw new Error("not used in these tests");
  },
  isValidDestination() {
    return true;
  },
};

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ASSET = { code: "USDC", issuer: ISSUER };

function payment(over: Partial<NormalizedPayment> = {}): NormalizedPayment {
  return {
    txHash: "tx1",
    pagingToken: "1",
    from: "GBUYER",
    to: DEST,
    amount: "10",
    asset: ASSET,
    memo: "ref_1",
    memoType: "text",
    toMuxedId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function makeTestService(links: FakeLinkRepository): LinkService {
  return new LinkService({
    links,
    sellers: {
      getDefault: async () => ({ id: "sel_1", name: "Seller", wallet: "GSELLER", createdAt: 0 }),
      findById: async () => null,
      findByWallet: async () => null,
      createIfAbsent: async () => ({ id: "sel_1", name: "Seller", wallet: "GSELLER", createdAt: 0 }),
    },
    webhooks: new FakeWebhookRepository(),
    rail: UNUSED_RAIL,
    offramp: new ScriptedOffRamp(),
    offrampState: new FakeOffRampStateRepository(),
    kyc: new AlwaysAcceptedKyc(),
    stellar: STELLAR,
    correlation: "memo",
    webhookGuard: async () => ({ ok: true }) as const,
  });
}

/** Feeds `p` through the real matcher against whatever `links` currently holds
 *  for `linkId`, then applies the outcome — mirrors what the watcher loop does
 *  per payment, one leg at a time. */
async function processPayment(
  service: LinkService,
  links: FakeLinkRepository,
  linkId: string,
  p: NormalizedPayment,
) {
  const current = links.get(linkId)!;
  const outcome = matchPayment(p, (ref) => (ref === current.reference ? current : undefined));
  await service.applyMatch(p, outcome);
  return outcome;
}

describe("LinkService.applyMatch — cumulative payment accounting (issue 1.4)", () => {
  it("two partial payments summing to the requested amount flip the link to paid", async () => {
    const links = new FakeLinkRepository([
      makeLink({ id: "lnk_1", reference: "ref_1", amount: "25", status: "active", paidAmount: null, txHash: null, payer: null }),
    ]);
    const service = makeTestService(links);

    const first = await processPayment(service, links, "lnk_1", payment({ txHash: "tx_a", amount: "10" }));
    expect(first.kind).toBe("underpaid");
    expect(links.get("lnk_1")!.status).toBe("underpaid");
    expect(links.get("lnk_1")!.paidAmount).toBe("10");

    const second = await processPayment(service, links, "lnk_1", payment({ txHash: "tx_b", amount: "15" }));
    expect(second.kind).toBe("paid");
    expect(links.get("lnk_1")!.status).toBe("paid");
    expect(links.get("lnk_1")!.paidAmount).toBe("25");
    expect(links.get("lnk_1")!.overpaidAmount).toBeNull();
  });

  it("three-way splits complete on the final leg", async () => {
    const links = new FakeLinkRepository([
      makeLink({ id: "lnk_1", reference: "ref_1", amount: "30", status: "active", paidAmount: null, txHash: null, payer: null }),
    ]);
    const service = makeTestService(links);

    await processPayment(service, links, "lnk_1", payment({ txHash: "tx_a", amount: "10" }));
    expect(links.get("lnk_1")!.status).toBe("underpaid");

    await processPayment(service, links, "lnk_1", payment({ txHash: "tx_b", amount: "10" }));
    expect(links.get("lnk_1")!.status).toBe("underpaid");
    expect(links.get("lnk_1")!.paidAmount).toBe("20");

    const third = await processPayment(service, links, "lnk_1", payment({ txHash: "tx_c", amount: "10" }));
    expect(third.kind).toBe("paid");
    expect(links.get("lnk_1")!.status).toBe("paid");
    expect(links.get("lnk_1")!.paidAmount).toBe("30");
  });

  it("overpayment on the final leg records the surplus in overpaidAmount", async () => {
    const links = new FakeLinkRepository([
      makeLink({ id: "lnk_1", reference: "ref_1", amount: "25", status: "active", paidAmount: null, txHash: null, payer: null }),
    ]);
    const service = makeTestService(links);

    await processPayment(service, links, "lnk_1", payment({ txHash: "tx_a", amount: "10" }));
    const final = await processPayment(service, links, "lnk_1", payment({ txHash: "tx_b", amount: "20" }));

    expect(final.kind).toBe("paid");
    expect(links.get("lnk_1")!.status).toBe("paid");
    expect(links.get("lnk_1")!.paidAmount).toBe("30");
    expect(links.get("lnk_1")!.overpaidAmount).toBe("5");
  });

  it("a duplicate tx hash never double-counts, even if applyMatch is somehow called twice", async () => {
    const links = new FakeLinkRepository([
      makeLink({ id: "lnk_1", reference: "ref_1", amount: "25", status: "active", paidAmount: null, txHash: null, payer: null }),
    ]);
    const service = makeTestService(links);

    const p = payment({ txHash: "tx_dupe", amount: "10" });
    await processPayment(service, links, "lnk_1", p);
    expect(links.get("lnk_1")!.paidAmount).toBe("10");

    // Reprocessing the identical payment (same tx hash) must not add a second
    // ledger row — recordPayment's dedup makes this a no-op past the first call.
    await service.applyMatch(p, { kind: "underpaid", link: links.get("lnk_1")!, receivedTotal: "10", outstanding: "15" });
    expect(links.get("lnk_1")!.paidAmount).toBe("10");
    expect(await links.sumPaymentsForLink("lnk_1")).toBe("10");
  });

  it("paidAmount always equals the sum of every recorded payment row", async () => {
    const links = new FakeLinkRepository([
      makeLink({ id: "lnk_1", reference: "ref_1", amount: "30", status: "active", paidAmount: null, txHash: null, payer: null }),
    ]);
    const service = makeTestService(links);

    await processPayment(service, links, "lnk_1", payment({ txHash: "tx_a", amount: "10" }));
    await processPayment(service, links, "lnk_1", payment({ txHash: "tx_b", amount: "12" }));
    await processPayment(service, links, "lnk_1", payment({ txHash: "tx_c", amount: "8" }));

    const link = links.get("lnk_1")!;
    expect(link.status).toBe("paid");
    expect(link.paidAmount).toBe(await links.sumPaymentsForLink("lnk_1"));
  });
});
