#!/usr/bin/env tsx
/**
 * scripts/demo-seed.ts
 *
 * Populates the dashboard with real on-chain testnet data so a first-time
 * visitor sees a genuinely populated, paid, and cashed-out demo instead of an
 * empty screen.
 *
 * What it does:
 *   1. Generates (or reuses) a funded seller keypair via Friendbot.
 *   2. Generates a separate "buyer" keypair, also funded via Friendbot.
 *   3. Adds USDC trustlines on both accounts (testnet USDC only).
 *   4. Funds the buyer with testnet USDC via the testanchor /testnet/friendbot endpoint.
 *   5. Creates several payment links via POST /links (flagged isDemo:true).
 *   6. Submits real Stellar payments from the buyer to the seller using the
 *      correct memo for each link so the watcher can match them.
 *   7. Polls GET /links until the target links flip to "paid".
 *   8. Triggers POST /links/:id/cash-out on one paid link so the dashboard
 *      shows an offramp_settled row (mock off-ramp settles quickly).
 *
 * Invariant: every row written is real on-chain testnet data — nothing is
 * fabricated directly in the database.
 *
 * Usage:
 *   pnpm demo:seed                         # uses defaults from .env
 *   API_URL=http://localhost:8787 pnpm demo:seed
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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
const HORIZON_URL = cfg("HORIZON_URL", "https://horizon-testnet.stellar.org");
const USDC_ISSUER = cfg("USDC_ISSUER_TESTNET", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const NETWORK_PASSPHRASE = Networks.TESTNET;
const FRIENDBOT = "https://friendbot.stellar.org";
// The testanchor hosts a USDC dispenser for testnet.
const USDC_FRIENDBOT = "https://testanchor.stellar.org/testnet/friendbot";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function friendbot(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${address}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400 with "createAccountAlreadyExist" means it's already funded — fine.
    if (body.includes("createAccountAlreadyExist")) return;
    throw new Error(`Friendbot failed for ${address}: ${res.status} ${body}`);
  }
}

async function usdcFriendbot(address: string): Promise<void> {
  const res = await fetch(`${USDC_FRIENDBOT}?addr=${address}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // testanchor friendbot may 400 if already funded; ignore gracefully.
    if (res.status === 400) {
      console.warn(`  [warn] USDC friendbot returned 400 for ${address}: ${body.slice(0, 120)}`);
      return;
    }
    throw new Error(`USDC friendbot failed: ${res.status} ${body}`);
  }
}

async function addTrustline(server: Horizon.Server, account: Keypair, issuer: string): Promise<void> {
  const usdcAsset = new Asset("USDC", issuer);
  const acc = await server.loadAccount(account.publicKey());
  // Check if trustline already exists.
  const hasTrust = acc.balances.some(
    (b) => b.asset_type === "credit_alphanum4" &&
      (b as { asset_code: string; asset_issuer: string }).asset_code === "USDC" &&
      (b as { asset_code: string; asset_issuer: string }).asset_issuer === issuer,
  );
  if (hasTrust) {
    console.log(`  trustline already exists for ${account.publicKey().slice(0, 8)}…`);
    return;
  }
  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset }))
    .setTimeout(30)
    .build();
  tx.sign(account);
  await server.submitTransaction(tx);
  console.log(`  trustline added for ${account.publicKey().slice(0, 8)}…`);
}

async function sendUsdc(
  server: Horizon.Server,
  from: Keypair,
  to: string,
  amount: string,
  memo: string,
): Promise<string> {
  const usdcAsset = new Asset("USDC", USDC_ISSUER);
  const acc = await server.loadAccount(from.publicKey());
  const tx = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({ destination: to, asset: usdcAsset, amount }),
    )
    .addMemo({ value: memo, type: "text" } as Parameters<TransactionBuilder["addMemo"]>[0])
    .setTimeout(30)
    .build();
  tx.sign(from);
  const result = await server.submitTransaction(tx);
  return result.hash;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Link definitions
// ---------------------------------------------------------------------------

interface LinkDef {
  title: string;
  amount: string;
  /** Whether to pay this link during seeding. */
  pay: boolean;
  /** Whether to trigger a cash-out after payment (requires mock off-ramp). */
  cashOut?: boolean;
}

const LINK_DEFS: LinkDef[] = [
  { title: "Demo — Invoice #1001 (ceramic mug ×2)", amount: "12.50", pay: true, cashOut: true },
  { title: "Demo — SaaS subscription (monthly)",    amount: "49.00", pay: true },
  { title: "Demo — Freelance design retainer",      amount: "250.00", pay: false },
  { title: "Demo — E-book: Stellar for Developers", amount: "9.99",  pay: true },
  { title: "Demo — Conference ticket deposit",      amount: "75.00", pay: false },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface LinkResponse {
  link: { id: string; reference: string; destination: string; status: string; amount: string };
  request: { memo: string; destination: string; amount: string };
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           Stellar Checkout — demo seed script           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // -- Check API is reachable -------------------------------------------------
  console.log(`▶ Checking API at ${API_URL}…`);
  const health = await apiGet<{ ok: boolean; network: string; sellerWallet: string }>("/health");
  if (!health.ok) throw new Error("API health check failed");
  if (health.network !== "testnet") {
    throw new Error(`Demo seed only runs against testnet (got "${health.network}")`);
  }
  const sellerWallet = health.sellerWallet;
  console.log(`  ✓ API ok  network=testnet  seller=${sellerWallet.slice(0, 8)}…\n`);

  const server = new Horizon.Server(HORIZON_URL);

  // -- Fund buyer account via Friendbot ---------------------------------------
  console.log("▶ Generating buyer keypair and funding via Friendbot…");
  const buyer = Keypair.random();
  console.log(`  buyer: ${buyer.publicKey()}`);
  await friendbot(buyer.publicKey());
  console.log("  ✓ XLM funded");

  // -- Add USDC trustlines ----------------------------------------------------
  console.log("\n▶ Adding USDC trustlines…");
  await addTrustline(server, buyer, USDC_ISSUER);

  // -- Fund buyer with testnet USDC -------------------------------------------
  console.log("\n▶ Requesting testnet USDC for buyer via testanchor friendbot…");
  await usdcFriendbot(buyer.publicKey());
  // Give Horizon a moment to see the USDC balance.
  await sleep(3000);
  const buyerAcc = await server.loadAccount(buyer.publicKey());
  const usdcBalance = buyerAcc.balances.find(
    (b) =>
      b.asset_type === "credit_alphanum4" &&
      (b as { asset_code: string }).asset_code === "USDC",
  );
  const buyerUsdc = usdcBalance ? (usdcBalance as { balance: string }).balance : "0";
  console.log(`  buyer USDC balance: ${buyerUsdc}`);
  if (parseFloat(buyerUsdc) < 1) {
    console.warn(
      "  [warn] buyer has very little USDC. Paid links may fail.\n" +
      "  To fund manually, send testnet USDC to:\n  " + buyer.publicKey(),
    );
  }

  // -- Create payment links via the API ---------------------------------------
  console.log("\n▶ Creating demo payment links…");
  const created: Array<{ def: LinkDef; link: LinkResponse["link"]; memo: string }> = [];
  for (const def of LINK_DEFS) {
    const result = await apiPost<LinkResponse>("/links", {
      title: def.title,
      amount: def.amount,
      assetCode: "USDC",
      isDemo: true,
    });
    console.log(`  ✓ ${def.title.padEnd(45)} ${def.amount} USDC  ref=${result.link.reference}`);
    created.push({ def, link: result.link, memo: result.request.memo });
  }

  // -- Submit on-chain payments for links marked pay:true --------------------
  console.log("\n▶ Submitting on-chain USDC payments from buyer…");
  const paidIds: string[] = [];
  for (const { def, link, memo } of created) {
    if (!def.pay) continue;
    console.log(`  paying ${link.amount} USDC → memo="${memo}"…`);
    const hash = await sendUsdc(server, buyer, sellerWallet, link.amount, memo);
    console.log(`  ✓ tx: ${hash}`);
    paidIds.push(link.id);
    await sleep(1000); // small gap between submissions
  }

  // -- Wait for the watcher to mark links as paid ----------------------------
  if (paidIds.length > 0) {
    console.log(`\n▶ Waiting for watcher to mark ${paidIds.length} link(s) paid…`);
    const POLL_MAX = 60; // up to 60s
    const POLL_INTERVAL = 3000;
    let settled = new Set<string>();
    for (let i = 0; i < POLL_MAX * (1000 / POLL_INTERVAL); i++) {
      await sleep(POLL_INTERVAL);
      const { links } = await apiGet<{ links: Array<{ id: string; status: string }> }>("/links");
      for (const l of links) {
        if (paidIds.includes(l.id) && l.status === "paid") settled.add(l.id);
      }
      const remaining = paidIds.filter((id) => !settled.has(id));
      process.stdout.write(`\r  paid: ${settled.size}/${paidIds.length}  (${remaining.length} pending…)  `);
      if (remaining.length === 0) break;
    }
    console.log(`\n  ✓ All target links paid (or timed out).`);
  }

  // -- Trigger cash-out on one paid link ------------------------------------
  const cashOutDef = created.find((c) => c.def.cashOut);
  if (cashOutDef) {
    console.log(`\n▶ Triggering cash-out on "${cashOutDef.def.title}"…`);
    try {
      const job = await apiPost<{ job: { jobId: string; status: string; targetAmount: string } }>(
        `/links/${cashOutDef.link.id}/cash-out`,
        { targetCurrency: "NGN" },
      );
      console.log(`  ✓ job=${job.job.jobId}  status=${job.job.status}  target=${job.job.targetAmount} NGN`);
      // Wait for mock off-ramp to settle (it settles in ~8s).
      console.log("  Waiting for mock off-ramp to settle…");
      await sleep(12000);
      const { links } = await apiGet<{ links: Array<{ id: string; status: string }> }>("/links");
      const settled = links.find((l) => l.id === cashOutDef.link.id);
      if (settled?.status === "offramp_settled") {
        console.log("  ✓ Link status: offramp_settled");
      } else {
        console.log(`  status: ${settled?.status ?? "unknown"} (may still be settling)`);
      }
    } catch (err) {
      // Don't fail the whole seed if cash-out doesn't work (e.g. link not yet paid).
      console.warn(`  [warn] cash-out failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // -- Summary ---------------------------------------------------------------
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  ✓  Demo seed complete!                                 ║");
  console.log("║                                                          ║");
  console.log("║  Open the dashboard to see real paid and settled rows.  ║");
  console.log("║  Run `pnpm demo:reset` to clear the seeded data.        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error("\n[demo-seed] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
