// Lifecycle of a payment link. The off-ramp states model the seller's
// cash-out leg and are only reachable after a link is paid.

export const LINK_STATUSES = [
  "active", // created, awaiting payment
  "paid", // a matching on-chain payment confirmed
  "underpaid", // a payment arrived but for less than requested
  "expired", // TTL elapsed before payment
  "cancelled", // seller voided the link
  "offramp_pending", // seller initiated cash-out to local currency
  "offramp_settled", // anchor confirmed local-currency payout
  "offramp_failed", // anchor payout failed (retryable)
] as const;

export type LinkStatus = (typeof LINK_STATUSES)[number];

const TRANSITIONS: Record<LinkStatus, readonly LinkStatus[]> = {
  active: ["paid", "underpaid", "expired", "cancelled"],
  // "underpaid" is self-reachable: a link can take more than one partial
  // top-up before it finally completes (issue 1.4 — split payments).
  underpaid: ["paid", "underpaid", "expired", "cancelled"],
  paid: ["offramp_pending"],
  offramp_pending: ["offramp_settled", "offramp_failed"],
  offramp_failed: ["offramp_pending"], // retry
  offramp_settled: [],
  expired: [],
  cancelled: [],
};

export function canTransition(from: LinkStatus, to: LinkStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: LinkStatus, to: LinkStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal link status transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: LinkStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
