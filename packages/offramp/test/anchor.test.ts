import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { AnchorOffRamp, mapSep24Status } from "../src/anchor";
import { parseStellarToml } from "../src/sep24";

const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("AnchorOffRamp (offline)", () => {
  it("parseStellarToml parses SEP-1 discovery endpoints correctly", () => {
    const toml = `
      WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
      TRANSFER_SERVER_SEP24 = "https://testanchor.stellar.org/sep24"
      ANCHOR_QUOTE_SERVER = "https://testanchor.stellar.org/sep38"
    `;
    const parsed = parseStellarToml(toml, "testanchor.stellar.org");
    expect(parsed.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
    expect(parsed.transferServerSep24).toBe("https://testanchor.stellar.org/sep24");
    expect(parsed.anchorQuoteServer).toBe("https://testanchor.stellar.org/sep38");
  });

  it("mapSep24Status maps SEP-24 transaction states onto OffRampJobStatus", () => {
    expect(mapSep24Status("completed")).toBe("settled");
    expect(mapSep24Status("error")).toBe("failed");
    expect(mapSep24Status("refunded")).toBe("failed");
    expect(mapSep24Status("expired")).toBe("failed");
    expect(mapSep24Status("pending_user_transfer_start")).toBe("pending");
    expect(mapSep24Status("pending_anchor")).toBe("pending");
    expect(mapSep24Status("pending_external")).toBe("pending");
  });
});

describe.skipIf(!process.env.RUN_LIVE_ANCHOR_TESTS)("AnchorOffRamp (live)", () => {
  it("quote(), initiate(), and status() execute SEP-24 flow against a live anchor", async () => {
    const homeDomain = process.env.ANCHOR_HOME_DOMAIN || "testanchor.stellar.org";
    const offramp = new AnchorOffRamp({
      homeDomain,
      sellerKeypair: Keypair.random(),
    });

    const quote = await offramp.quote({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "USD",
    });

    expect(Number(quote.rate)).toBeGreaterThan(0);
    expect(quote.quoteId).toBeTruthy();

    const initiation = await offramp.initiate({
      linkId: "test-link-sep24",
      quoteId: quote.quoteId,
      payout: {
        currency: "USD",
        fields: { dest: "1234567890" },
      },
    });

    expect(initiation.kind).toBe("interactive");
    expect(initiation.jobId).toBeTruthy();
    if (initiation.kind === "interactive") {
      expect(initiation.url).toBeTruthy();
    }

    const jobStatus = await offramp.status(initiation.jobId);
    expect(["pending", "settled", "failed"]).toContain(jobStatus.status);
  });
});
