import { Asset, Horizon, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type {
  AssetRef,
  OffRampInitiation,
  OffRampJob,
  OffRampJobStatus,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  SellerPayoutRef,
} from "@checkout/core";
import { getSep38Quote } from "./sep38";
import { Sep24Client, type Sep24Transaction } from "./sep24";

export interface AnchorOptions {
  homeDomain: string;
  sellerKeypair: Keypair;
  horizonUrl?: string;
}

interface StoredQuote {
  sellAsset: AssetRef;
  sellAmount: string;
  buyCurrency: string;
  price: string;
}

interface StoredJob {
  linkId: string;
  targetCurrency: string;
  targetAmount: string;
  rate: string;
  sendTxHash?: string;
  sending?: boolean;
}

export function mapSep24Status(status: string): OffRampJobStatus {
  if (status === "completed") return "settled";
  if (status === "error" || status === "refunded" || status === "expired") return "failed";
  // pending_user_transfer_start, pending_anchor, pending_external, pending_user_info_required, incomplete
  return "pending";
}

export class AnchorOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";

  private readonly homeDomain: string;
  private readonly sellerKeypair: Keypair;
  private readonly horizonUrl: string;
  private readonly sep24: Sep24Client;
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly jobs = new Map<string, StoredJob>();

  constructor(opts: AnchorOptions) {
    this.homeDomain = opts.homeDomain;
    this.sellerKeypair = opts.sellerKeypair;
    this.horizonUrl = opts.horizonUrl || "https://horizon-testnet.stellar.org";
    this.sep24 = new Sep24Client(opts.sellerKeypair, opts.homeDomain);
  }

  async quote(input: {
    sourceAsset: AssetRef;
    sourceAmount: string;
    targetCurrency: string;
  }): Promise<OffRampQuote> {
    const discovery = await this.sep24.getDiscoveryInfo();
    const token = await this.sep24["getAuthToken"]();

    const q = await getSep38Quote(discovery.anchorQuoteServer, token, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
    });

    this.quotes.set(q.id, {
      sellAsset: input.sourceAsset,
      sellAmount: input.sourceAmount,
      buyCurrency: input.targetCurrency,
      price: q.price,
    });

    // Gross is what sourceAmount converts to at the quoted rate; buyAmount is
    // what the anchor actually pays out — the difference is its fee (issue 1.5).
    const grossTargetAmount = (Number(input.sourceAmount) / Number(q.price)).toFixed(4);
    const netTargetAmount = q.buyAmount;
    const feeAmount = (Number(grossTargetAmount) - Number(netTargetAmount)).toFixed(4);

    return {
      quoteId: q.id,
      sourceAsset: input.sourceAsset,
      sourceAmount: input.sourceAmount,
      targetCurrency: input.targetCurrency,
      targetAmount: grossTargetAmount,
      rate: q.price,
      expiresAt: Date.parse(q.expiresAt),
      fee: { amount: feeAmount, currency: input.targetCurrency, source: "anchor" },
      netTargetAmount,
    };
  }

  async initiate(input: {
    linkId: string;
    quoteId: string;
    payout: SellerPayoutRef;
  }): Promise<OffRampInitiation> {
    const q = this.quotes.get(input.quoteId);
    if (!q) throw new Error("Unknown or expired quote");

    const interactiveResult = await this.sep24.startInteractiveWithdraw({
      assetCode: q.sellAsset.code,
      assetIssuer: q.sellAsset.issuer || undefined,
      amount: q.sellAmount,
      account: this.sellerKeypair.publicKey(),
      quoteId: input.quoteId,
      payoutFields: input.payout.fields,
    });

    this.jobs.set(interactiveResult.id, {
      linkId: input.linkId,
      targetCurrency: q.buyCurrency,
      targetAmount: "",
      rate: q.price,
    });

    return {
      kind: "interactive",
      jobId: interactiveResult.id,
      url: interactiveResult.url,
    };
  }

  async status(jobId: string): Promise<OffRampJob> {
    let stored = this.jobs.get(jobId);
    if (!stored) {
      stored = {
        linkId: "",
        targetCurrency: "NGN",
        targetAmount: "",
        rate: "0",
      };
      this.jobs.set(jobId, stored);
    }

    const tx: Sep24Transaction = await this.sep24.getTransaction(jobId);

    // Handle Send Leg if anchor is waiting for user transfer
    if (tx.status === "pending_user_transfer_start" && !stored.sendTxHash && !stored.sending && tx.withdrawAnchorAccount && tx.withdrawMemo) {
      stored.sending = true;
      try {
        const hash = await this.sendWithdrawalPayment(
          tx.withdrawAnchorAccount,
          tx.withdrawMemo,
          tx.withdrawMemoType || "text",
          tx.amountIn || "0"
        );
        stored.sendTxHash = hash;
      } catch (err) {
        console.error("Failed to send on-chain withdrawal payment to anchor:", err);
      } finally {
        stored.sending = false;
      }
    }

    const jobStatus = mapSep24Status(tx.status);

    return {
      jobId: tx.id,
      linkId: stored.linkId,
      status: jobStatus,
      targetCurrency: stored.targetCurrency,
      targetAmount: tx.amountOut || stored.targetAmount,
      rate: stored.rate,
      reason: tx.message,
    };
  }

  private async sendWithdrawalPayment(
    destination: string,
    memoStr: string,
    memoType: string,
    amount: string
  ): Promise<string> {
    const server = new Horizon.Server(this.horizonUrl);
    const account = await server.loadAccount(this.sellerKeypair.publicKey());

    let memo: Memo;
    if (memoType === "id") {
      memo = Memo.id(memoStr);
    } else if (memoType === "hash") {
      memo = Memo.hash(memoStr);
    } else {
      memo = Memo.text(memoStr);
    }

    const tx = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.horizonUrl.includes("public")
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; July 2015",
    })
      .addOperation(
        Operation.payment({
          destination,
          asset: Asset.native(), // Default native or issued asset transfer
          amount,
        })
      )
      .addMemo(memo)
      .setTimeout(30)
      .build();

    tx.sign(this.sellerKeypair);
    const res = await server.submitTransaction(tx);
    return res.hash;
  }
}
