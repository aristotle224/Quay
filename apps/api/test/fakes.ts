import type {
  CreateLinkInput,
  KycPort,
  KycRecord,
  LinkRepository,
  OffRampJob,
  OffRampMode,
  OffRampPort,
  OffRampQuote,
  OffRampStateRepository,
  PaymentLink,
  StoredOffRampJob,
  StoredOffRampQuote,
  Webhook,
  WebhookDelivery,
  WebhookRepository,
} from "@checkout/core";
import { encryptSecret } from "../src/services/secret-crypto";

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function makeLink(over: Partial<PaymentLink> = {}): PaymentLink {
  return {
    id: "lnk_1",
    reference: "pl_ref1",
    sellerId: "sel_1",
    destination: DEST,
    muxedId: null,
    title: "Test",
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "paid",
    txHash: "tx1",
    payer: "GBUYER",
    paidAmount: "10",
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    expiresAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** In-memory LinkRepository, seeded from a fixed list of links. */
export class FakeLinkRepository implements LinkRepository {
  private readonly byId = new Map<string, PaymentLink>();

  constructor(seed: PaymentLink[] = []) {
    for (const l of seed) this.byId.set(l.id, l);
  }

  async create(input: CreateLinkInput): Promise<PaymentLink> {
    const link: PaymentLink = {
      ...input,
      offrampIndicativeRate: null,
      offrampRate: null,
      offrampRateDelta: null,
      status: "active",
      txHash: null,
      payer: null,
      paidAmount: null,
      offrampJobId: null,
      offrampTargetCurrency: null,
      offrampStatus: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.byId.set(link.id, link);
    return link;
  }

  async findById(id: string): Promise<PaymentLink | null> {
    return this.byId.get(id) ?? null;
  }

  async findByReference(reference: string): Promise<PaymentLink | null> {
    return [...this.byId.values()].find((l) => l.reference === reference) ?? null;
  }

  async listBySeller(sellerId: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.sellerId === sellerId);
  }

  async listByStatus(status: PaymentLink["status"]): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter((l) => l.status === status);
  }

  async activeDestinations(): Promise<string[]> {
    return [...new Set([...this.byId.values()].map((l) => l.destination))];
  }

  async openLinksForDestination(destination: string): Promise<PaymentLink[]> {
    return [...this.byId.values()].filter(
      (l) => l.destination === destination && (l.status === "active" || l.status === "underpaid"),
    );
  }

  async save(link: PaymentLink): Promise<void> {
    this.byId.set(link.id, { ...link });
  }

  get(id: string): PaymentLink | undefined {
    return this.byId.get(id);
  }
}

export class FakeWebhookRepository implements WebhookRepository {
  readonly deliveries: WebhookDelivery[] = [];
  private readonly hooks: Webhook[] = [];

  async create(input: { sellerId: string; url: string; secret: string }): Promise<Webhook> {
    const hook: Webhook = {
      id: `whk_${this.hooks.length}`,
      sellerId: input.sellerId,
      url: input.url,
      secretEncrypted: encryptSecret(input.secret),
      secretLast4: input.secret.slice(-4),
      previousSecretEncrypted: null,
      previousSecretLast4: null,
      previousSecretExpiresAt: null,
      deletedAt: null,
      createdAt: Date.now(),
    };
    this.hooks.push(hook);
    return hook;
  }

  async listDeliveriesByLinkId(linkId: string): Promise<WebhookDelivery[]> {
    return this.deliveries.filter((d) => d.linkId === linkId);
  }

  async listBySeller(sellerId: string): Promise<Webhook[]> {
    return this.hooks.filter((h) => h.sellerId === sellerId && h.deletedAt === null);
  }

  async getById(id: string, sellerId: string, opts?: { includeDeleted?: boolean }): Promise<Webhook | null> {
    const hook = this.hooks.find((h) => h.id === id && h.sellerId === sellerId);
    if (!hook) return null;
    if (hook.deletedAt !== null && !opts?.includeDeleted) return null;
    return hook;
  }

  async rotateSecret(id: string, sellerId: string, newSecret: string, overlapMs: number): Promise<Webhook | null> {
    const hook = await this.getById(id, sellerId);
    if (!hook) return null;
    hook.previousSecretEncrypted = hook.secretEncrypted;
    hook.previousSecretLast4 = hook.secretLast4;
    hook.previousSecretExpiresAt = Date.now() + overlapMs;
    hook.secretEncrypted = encryptSecret(newSecret);
    hook.secretLast4 = newSecret.slice(-4);
    return hook;
  }

  async softDelete(id: string, sellerId: string): Promise<boolean> {
    const hook = await this.getById(id, sellerId);
    if (!hook) return false;
    hook.deletedAt = Date.now();
    return true;
  }

  async recordDelivery(d: Omit<WebhookDelivery, "id" | "createdAt">): Promise<void> {
    this.deliveries.push({ ...d, id: `whd_${this.deliveries.length}`, createdAt: Date.now() });
  }

  async listDeliveries(
    webhookId: string,
    sellerId: string,
    opts: { limit: number; cursor?: string | null },
  ): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }> {
    const owned = await this.getById(webhookId, sellerId, { includeDeleted: true });
    if (!owned) return { deliveries: [], nextCursor: null };
    const matching = this.deliveries
      .filter((d) => d.webhookId === webhookId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return { deliveries: matching.slice(0, opts.limit), nextCursor: null };
  }
}

/** In-memory OffRampStateRepository — same shape as the Drizzle one, no DB. */
export class FakeOffRampStateRepository implements OffRampStateRepository {
  private readonly quotes = new Map<string, StoredOffRampQuote>();
  private readonly jobs = new Map<string, StoredOffRampJob>();

  async saveQuote(quote: StoredOffRampQuote): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
  }

  async getQuote(quoteId: string): Promise<StoredOffRampQuote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  async saveJob(job: StoredOffRampJob): Promise<void> {
    this.jobs.set(job.jobId, job);
  }

  async getJob(jobId: string): Promise<StoredOffRampJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async updateJob(
    jobId: string,
    patch: Partial<Pick<StoredOffRampJob, "targetAmount" | "status" | "externalStatus" | "lastError">>,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.jobs.set(jobId, { ...job, ...patch, updatedAt: Date.now() });
  }
}

/** Fully scripted OffRampPort: each method call is driven by a queued/fixed handler. */
export class ScriptedOffRamp implements OffRampPort {
  readonly mode: OffRampMode = "seller_initiated";
  statusImpl: (jobId: string) => Promise<OffRampJob> = () => {
    throw new Error("statusImpl not configured");
  };

  async quote(): Promise<OffRampQuote> {
    throw new Error("not used in these tests");
  }
  async initiate(): Promise<OffRampJob> {
    throw new Error("not used in these tests");
  }
  async status(jobId: string): Promise<OffRampJob> {
    return this.statusImpl(jobId);
  }
}

/** KYC gate that's always ACCEPTED — mirrors `NoKycRequired`, used by tests
 *  that aren't exercising the KYC gate itself. */
export class AlwaysAcceptedKyc implements KycPort {
  async status(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }
  async submit(sellerId: string): Promise<KycRecord> {
    return this.accepted(sellerId);
  }
  private accepted(sellerId: string): KycRecord {
    return {
      sellerId,
      customerId: null,
      status: "ACCEPTED",
      requiredFields: [],
      providedFields: {},
      message: null,
      lastSyncedAt: null,
      updatedAt: Date.now(),
    };
  }
}

/** Fully scripted KycPort for testing the cash-out gate itself. */
export class ScriptedKyc implements KycPort {
  statusImpl: (sellerId: string) => Promise<KycRecord> = () => {
    throw new Error("statusImpl not configured");
  };
  async status(sellerId: string): Promise<KycRecord> {
    return this.statusImpl(sellerId);
  }
  async submit(sellerId: string): Promise<KycRecord> {
    return this.statusImpl(sellerId);
  }
}
