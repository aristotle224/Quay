import Link from "next/link";
import { api, type WebhookDelivery, type PaymentLink } from "../../../lib/api";
import { TimelineClient } from "./TimelineClient";

interface TimelineEvent {
  id: string;
  time: number;
  type: "created" | "paid" | "underpaid" | "expired" | "cancelled" | "offramp_pending" | "offramp_settled" | "offramp_failed" | "webhook_attempt";
  label: string;
  detail?: string;
  meta?: Record<string, string | null>;
}

function buildTimeline(link: PaymentLink, deliveries: WebhookDelivery[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Created
  events.push({
    id: "created",
    time: link.createdAt,
    type: "created",
    label: "Link created",
    meta: { title: link.title, amount: `${link.amount} ${link.asset.code}` },
  });

  // Paid / underpaid
  if (link.txHash && link.paidAmount) {
    events.push({
      id: "paid",
      time: link.updatedAt,
      type: link.status === "underpaid" ? "underpaid" : "paid",
      label: link.status === "underpaid" ? "Underpaid" : "Payment received",
      detail: link.txHash,
      meta: {
        payer: link.payer,
        amount: `${link.paidAmount} ${link.asset.code}`,
      },
    });
  }

  // Off-ramp stages
  if (link.offrampJobId && link.offrampStatus) {
    // We approximate the quoted/initiated time from the first offramp delivery
    const offrampDeliveries = deliveries.filter((d) => d.event.startsWith("offramp."));
    const firstOfframp = offrampDeliveries[0];

    events.push({
      id: "offramp_quoted",
      time: firstOfframp?.createdAt ?? link.updatedAt,
      type: "offramp_pending",
      label: "Off-ramp initiated",
      detail: link.offrampTargetCurrency
        ? `Cash-out to ${link.offrampTargetCurrency}`
        : undefined,
    });

    if (link.offrampStatus === "settled") {
      events.push({
        id: "offramp_settled",
        time: link.updatedAt,
        type: "offramp_settled",
        label: "Off-ramp settled",
        detail: `Settled in ${link.offrampTargetCurrency}`,
      });
    } else if (link.offrampStatus === "failed") {
      events.push({
        id: "offramp_failed",
        time: link.updatedAt,
        type: "offramp_failed",
        label: "Off-ramp failed",
      });
    }
  }

  // Webhook delivery attempts
  for (const d of deliveries) {
    events.push({
      id: `wh_${d.createdAt}_${d.event}`,
      time: d.createdAt,
      type: "webhook_attempt",
      label: `Webhook: ${d.event}`,
      detail: d.ok ? `HTTP ${d.statusCode}` : d.error ?? `HTTP ${d.statusCode}`,
      meta: { ok: d.ok ? "✓" : "✗" },
    });
  }

  // Expired / cancelled
  if (link.status === "expired") {
    events.push({
      id: "expired",
      time: link.updatedAt,
      type: "expired",
      label: "Expired",
    });
  } else if (link.status === "cancelled") {
    events.push({
      id: "cancelled",
      time: link.updatedAt,
      type: "cancelled",
      label: "Cancelled",
    });
  }

  return events.sort((a, b) => a.time - b.time);
}

function explorerUrl(network: string, hash: string): string {
  const base = network === "public" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
  return `${base}/tx/${hash}`;
}

function addressUrl(network: string, addr: string): string {
  const base = network === "public" ? "https://stellar.expert/explorer/public" : "https://stellar.expert/explorer/testnet";
  return `${base}/account/${addr}`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function EventDot({ type }: { type: TimelineEvent["type"] }) {
  const cls =
    type === "created"
      ? "dot--created"
      : type === "paid"
        ? "dot--paid"
        : type === "underpaid"
          ? "dot--underpaid"
          : type === "webhook_attempt"
            ? "dot--webhook"
            : type === "offramp_settled"
              ? "dot--settled"
              : type === "offramp_failed" || type === "expired" || type === "cancelled"
                ? "dot--failed"
                : "dot--pending";
  return <span className={`tl-dot ${cls}`} />;
}

export default async function LinkDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let link: PaymentLink;
  let deliveries: WebhookDelivery[];
  try {
    const detail = await api.getDetail(id);
    link = detail.link;
    deliveries = detail.deliveries;
  } catch {
    return (
      <main className="shell shell--narrow">
        <div className="panel" style={{ textAlign: "center" }}>
          <p className="title">Link not found</p>
          <p className="muted">This link may have been removed, or the ID is wrong.</p>
          <Link className="linkbtn" href="/">Back to dashboard</Link>
        </div>
      </main>
    );
  }

  // Determine network from the environment (default to testnet)
  const network = (process.env.STELLAR_NETWORK ?? "testnet") === "public" ? "public" : "testnet";

  const events = buildTimeline(link, deliveries);

  return (
    <main className="shell">
      <header className="masthead">
        <Link href="/" className="linkbtn" style={{ fontSize: 13 }}>← Back to dashboard</Link>
        <span className="net mono">{link.asset.code}</span>
      </header>

      {/* Header card */}
      <section className="panel tl-header">
        <div className="tl-header-row">
          <div>
            <h2 className="tl-title">{link.title}</h2>
            <span className="tl-ref mono">{link.reference}</span>
          </div>
          <div className="tl-header-right">
            <span className={`pill pill--${link.status}`}>
              {link.status.replace("offramp_", "off-ramp ").replace("_", " ")}
            </span>
            <div className="tl-amount mono">{link.amount} {link.asset.code}</div>
          </div>
        </div>
        {link.paidAmount && (
          <div className="tl-paid-row">
            <span className="muted">Paid: </span>
            <span className="mono">{link.paidAmount} {link.asset.code}</span>
          </div>
        )}
      </section>

      {/* Timeline */}
      <section className="panel">
        <h2>Timeline</h2>
        <div className="tl-timeline">
          {events.map((ev, i) => (
            <div key={ev.id} className="tl-event">
              <div className="tl-event-line">
                <EventDot type={ev.type} />
                {i < events.length - 1 && <div className="tl-line" />}
              </div>
              <div className="tl-event-body">
                <div className="tl-event-header">
                  <span className="tl-event-label">{ev.label}</span>
                  {ev.meta?.ok && (
                    <span className={ev.meta.ok === "✓" ? "tl-ok" : "tl-fail"}>{ev.meta.ok}</span>
                  )}
                </div>
                <div className="tl-event-time">{formatTime(ev.time)}</div>
                {ev.detail && (
                  <div className="tl-event-detail">
                    {ev.type === "paid" || ev.type === "underpaid" ? (
                      <a
                        href={explorerUrl(network, ev.detail)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mono explorer-link"
                      >
                        {ev.detail.slice(0, 16)}…{ev.detail.slice(-8)}
                      </a>
                    ) : (
                      <span className="mono muted">{ev.detail}</span>
                    )}
                  </div>
                )}
                {ev.meta?.payer && (
                  <div className="tl-event-detail">
                    <span className="muted">Payer: </span>
                    <a
                      href={addressUrl(network, ev.meta.payer)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono explorer-link"
                    >
                      {ev.meta.payer.slice(0, 8)}…{ev.meta.payer.slice(-6)}
                    </a>
                  </div>
                )}
                {ev.meta?.amount && (
                  <div className="tl-event-detail">
                    <span className="mono">{ev.meta.amount}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Raw data section for debugging / advanced users */}
      <section className="panel">
        <h2>Details</h2>
        <dl className="tl-details">
          <div className="tl-dt-row">
            <dt>ID</dt>
            <dd className="mono">{link.id}</dd>
          </div>
          <div className="tl-dt-row">
            <dt>Reference</dt>
            <dd className="mono">{link.reference}</dd>
          </div>
          <div className="tl-dt-row">
            <dt>Destination</dt>
            <dd className="mono">
              <a href={addressUrl(network, link.destination)} target="_blank" rel="noopener noreferrer" className="explorer-link">
                {link.destination}
              </a>
            </dd>
          </div>
          {link.txHash && (
            <div className="tl-dt-row">
              <dt>Transaction</dt>
              <dd className="mono">
                <a href={explorerUrl(network, link.txHash)} target="_blank" rel="noopener noreferrer" className="explorer-link">
                  {link.txHash}
                </a>
              </dd>
            </div>
          )}
          {link.payer && (
            <div className="tl-dt-row">
              <dt>Payer</dt>
              <dd className="mono">{link.payer}</dd>
            </div>
          )}
          {link.offrampJobId && (
            <div className="tl-dt-row">
              <dt>Off-ramp Job ID</dt>
              <dd className="mono">{link.offrampJobId}</dd>
            </div>
          )}
          {link.expiresAt && (
            <div className="tl-dt-row">
              <dt>Expires</dt>
              <dd>{formatTime(link.expiresAt)}</dd>
            </div>
          )}
          <div className="tl-dt-row">
            <dt>Created</dt>
            <dd>{formatTime(link.createdAt)}</dd>
          </div>
          <div className="tl-dt-row">
            <dt>Updated</dt>
            <dd>{formatTime(link.updatedAt)}</dd>
          </div>
        </dl>
      </section>

      {/* Purchase receipt link (public, no auth) */}
      <section className="panel">
        <h2>Receipt</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Share this link with the buyer for proof of payment.
        </p>
        <TimelineClient linkId={link.id} reference={link.reference} />
      </section>
    </main>
  );
}
