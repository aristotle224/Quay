"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  CheckoutError,
  describeError,
  type KycView,
  type PaymentLink,
  type UsdcTrustlineStatus,
} from "../../lib/api";
import KycPanel from "./KycPanel";

// Mirrors the API's OFFRAMP setting (see .env.example) so this button never
// claims a real payout when the backend is still running MockAnchorOffRamp.
const OFFRAMP_CURRENCY = process.env.NEXT_PUBLIC_OFFRAMP_CURRENCY ?? "NGN";
const OFFRAMP_IS_MOCK = (process.env.NEXT_PUBLIC_OFFRAMP_MODE ?? "mock") !== "testanchor";
const CASH_OUT_LABEL = OFFRAMP_IS_MOCK
  ? `Cash out to ${OFFRAMP_CURRENCY} (simulated)`
  : `Cash out to ${OFFRAMP_CURRENCY}`;

// ── Small helpers ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  const label = status.replace("offramp_", "off-ramp ").replace("_", " ");
  return <span className={`pill pill--${status}`}>{label}</span>;
}

function DemoBadge() {
  return (
    <span
      className="pill"
      style={{ background: "var(--surface-2, #f3f4f6)", color: "var(--text-2, #6b7280)", fontSize: "0.7rem" }}
      title="Created by the demo seed script — real on-chain testnet data"
    >
      demo
    </span>
  );
}

function amountLabel(link: PaymentLink): string {
  return `${link.amount} ${link.asset.code}`;
}

function SkeletonTable() {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Amount</th>
          <th>Status</th>
          <th className="hide-sm">Reference</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {[1, 2, 3].map((i) => (
          <tr key={i}>
            <td>
              <span className="skeleton skeleton--w140" />
            </td>
            <td className="amt">
              <span className="skeleton skeleton--w80" />
            </td>
            <td>
              <span className="skeleton skeleton--w60" />
            </td>
            <td className="hide-sm">
              <span className="skeleton skeleton--w120" />
            </td>
            <td style={{ textAlign: "right" }}>
              <span className="skeleton skeleton--w90 skeleton--right" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ErrorBanner({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="error-banner">
      <p className="error-banner__text">{message}</p>
      <button className="btn btn--ghost" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Inline indicative rate badge shown next to a paid link (issue 3.5).
 * Fetches once when the component mounts; clearly labelled "indicative" so
 * the seller understands no firm quote has been consumed.
 */
function IndicativeRateBadge({ linkId }: { linkId: string }) {
  const [price, setPrice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .getOfframpPreview(linkId, OFFRAMP_CURRENCY)
      .then((preview) => {
        if (cancelled) return;
        const entry = preview.prices.find((p) => p.targetCurrency === OFFRAMP_CURRENCY);
        setPrice(entry?.price ?? null);
      })
      .catch(() => {
        // Non-fatal: the rate preview is best-effort.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkId]);

  if (loading) return <span className="muted" style={{ fontSize: "0.75rem" }}>rate…</span>;
  if (!price) return null;

  return (
    <span
      className="muted"
      style={{ fontSize: "0.75rem" }}
      title="Indicative rate from SEP-38 GET /prices — no firm quote consumed"
    >
      ~{Number(price).toLocaleString()} {OFFRAMP_CURRENCY}
      <span style={{ marginLeft: 3, opacity: 0.6 }}>(indicative)</span>
    </span>
  );
}

interface TableProps {
  links: PaymentLink[];
  copied: string | null;
  onCopy: (id: string) => void;
  onCashOut: (id: string) => void;
  cashOutBlocked: boolean;
}

function LinksTable({ links, copied, onCopy, onCashOut, cashOutBlocked }: TableProps) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Title</th>
          <th>Amount</th>
          <th>Status</th>
          <th className="hide-sm">Reference</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {links.map((link) => (
          <tr key={link.id}>
            <td>
              <Link href={`/links/${link.id}`} className="dash-link-title">
                {link.title}
              </Link>
              {link.isDemo && <> <DemoBadge /></>}
            </td>
            <td className="amt">
              {amountLabel(link)}
              {/* Indicative rate shown inline for paid links — no firm quote burned */}
              {link.status === "paid" && (
                <div style={{ marginTop: 2 }}>
                  <IndicativeRateBadge linkId={link.id} />
                </div>
              )}
            </td>
            <td>
              <StatusPill status={link.status} />
            </td>
            <td className="hide-sm">
              <span className="mono muted">{link.reference}</span>
            </td>
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              <button className="linkbtn" onClick={() => onCopy(link.id)}>
                {copied === link.id ? "Copied" : "Copy link"}
              </button>
              {link.status === "paid" && (
                <>
                  {" · "}
                  {cashOutBlocked ? (
                    <span className="muted" style={{ fontSize: 12 }} title="Complete identity verification above">
                      Identity verification required
                    </span>
                  ) : (
                    <button className="linkbtn" onClick={() => onCashOut(link.id)}>
                      {CASH_OUT_LABEL}
                    </button>
                  )}
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Create-link form
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [assetCode, setAssetCode] = useState<"USDC" | "XLM">("USDC");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [trustline, setTrustline] = useState<UsdcTrustlineStatus | null>(null);
  const [kyc, setKyc] = useState<KycView | null>(null);
  const [cashOutQuote, setCashOutQuote] = useState<{
    linkId: string;
    gross: string;
    fee: string;
    net: string;
    currency: string;
    source: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { links: fresh } = await api.listLinks();
      setLinks(fresh);
      setFetchError(null);
    } catch (e) {
      const msg =
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to load links. Please try again.";
      // If we already have data, keep showing it with a banner on top.
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshKyc = useCallback(async () => {
    if (OFFRAMP_IS_MOCK) return; // no real anchor, nothing to verify
    try {
      setKyc(await api.getKyc());
    } catch {
      /* dashboard still works without it; the cash-out button just stays gated */
    }
  }, []);

  const refreshTrustline = useCallback(async () => {
    try {
      const health = await api.health();
      setTrustline(health.usdcTrustline);
    } catch {
      // Health check itself failing is surfaced by the rest of the dashboard
      // (links won't load either) — don't also blank out a banner that was
      // showing real, still-relevant information.
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshTrustline();
    const t = setInterval(refresh, 5_000);
    const th = setInterval(refreshTrustline, 15_000);
    return () => {
      clearInterval(t);
      clearInterval(th);
    };
  }, [refresh, refreshTrustline]);

  useEffect(() => {
    void refreshKyc();
  }, [refreshKyc]);

  async function create() {
    setActionError(null);
    if (!title.trim() || !amount.trim()) {
      setActionError("Add a title and an amount.");
      return;
    }
    setCreating(true);
    try {
      const { link } = await api.createLink({
        title: title.trim(),
        amount: amount.trim(),
        assetCode,
      });
      setTitle("");
      setAmount("");
      setLinks((prev) => [link, ...prev]);
    } catch (e) {
      setActionError(
        e instanceof CheckoutError
          ? describeError(e)
          : "Failed to create the payment link. Please try again.",
      );
      if (e instanceof CheckoutError && e.code === "destination_cannot_receive") {
        void refreshTrustline(); // don't wait up to 15s for the banner to catch up
      }
    } finally {
      setCreating(false);
    }
  }

  async function copyCheckout(id: string) {
    const url = `${window.location.origin}/pay/${id}`;
    await navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  }

  async function copyWidgetHtml(link: PaymentLink) {
    const host = window.location.origin;
    const snippet = `<script src="${host}/widget.js" defer></script>\n<button data-quay-link="${link.id}" data-quay-label="Pay ${link.amount} ${link.asset.code}">Pay</button>`;
    await navigator.clipboard.writeText(snippet);
    setCopied(`widget_${link.id}`);
    setTimeout(() => setCopied((c) => (c === `widget_${link.id}` ? null : c)), 1500);
  }

  /**
   * Cash-out: this is the only place a firm SEP-38 quote is consumed.
   * The indicative rate shown inline in the table is from GET /prices
   * and does not commit to anything (issue 3.5).
   */
  async function cashOut(id: string) {
    setActionError(null);
    try {
      const q = await api.quoteCashOut(id, OFFRAMP_CURRENCY);
      setCashOutQuote({
        linkId: id,
        gross: q.targetAmount,
        fee: q.fee.amount,
        net: q.netTargetAmount,
        currency: q.fee.currency,
        source: q.fee.source,
      });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Failed to get cash-out quote");
    }
  }

  async function confirmCashOut() {
    if (!cashOutQuote) return;
    setActionError(null);
    try {
      await api.cashOut(cashOutQuote.linkId, OFFRAMP_CURRENCY);
      setCashOutQuote(null);
      await refresh();
    } catch (e) {
      if (e instanceof CheckoutError && e.code === "kyc_required") {
        setActionError(describeError(e));
        void refreshKyc();
        return;
      }
      setActionError(
        e instanceof CheckoutError ? describeError(e) : "Cash-out failed. Please try again.",
      );
    }
  }

  const [csvFrom, setCsvFrom] = useState("");
  const [csvTo, setCsvTo] = useState("");
  const [exporting, setExporting] = useState(false);

  async function handleCsvExport() {
    setExporting(true);
    try {
      const blob = await api.exportCsv(csvFrom || undefined, csvTo || undefined);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `quay-links-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }
  // Real anchor and not yet verified: never let the seller submit a cash-out
  // that can only fail (or worse, silently carry placeholder identity data).
  const cashOutBlocked = !OFFRAMP_IS_MOCK && kyc?.status !== "ACCEPTED";

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <>
      {trustline && !trustline.ok && (
        <div className="banner banner--warn">
          <strong>Your wallet can&apos;t receive USDC right now.</strong>{" "}
          {trustline.message}
          {trustline.trustlineUri && (
            <>
              {" "}
              <a className="linkbtn" href={trustline.trustlineUri}>
                Add USDC trustline
              </a>
            </>
          )}
        </div>
      )}

      <section className="panel">
        <h2>New payment link</h2>
        <div className="field">
          <label htmlFor="title">What is this for</label>
          <input
            id="title"
            placeholder="Invoice #1024 — 2x ceramic mug"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="amount">Amount</label>
            <input
              id="amount"
              className="mono"
              inputMode="decimal"
              placeholder="25.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="asset">Asset</label>
            <select
              id="asset"
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value as "USDC" | "XLM")}
            >
              <option value="USDC">USDC</option>
              <option value="XLM">XLM</option>
            </select>
          </div>
        </div>
        <button className="btn btn--primary btn--block" onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create link"}
        </button>
        {actionError && <div className="err">{actionError}</div>}
      </section>

      {!OFFRAMP_IS_MOCK && <KycPanel kyc={kyc} onUpdated={setKyc} />}

      <section className="panel">
        <h2>Links</h2>

        {loading && <SkeletonTable />}

        {!loading && fetchError && links.length === 0 && (
          <ErrorBanner message={fetchError} onRetry={refresh} />
        )}

        {!loading && fetchError && links.length > 0 && (
          <>
            <ErrorBanner message={fetchError} onRetry={refresh} />
            <div style={{ marginTop: 16 }}>
              <LinksTable
                links={links}
                copied={copied}
                onCopy={copyCheckout}
                onCashOut={cashOut}
                cashOutBlocked={cashOutBlocked}
              />
            </div>
          </>
        )}

        {!loading && !fetchError && links.length === 0 && (
          <div className="empty">No links yet. Create one above to get a checkout page.</div>
        )}

        {!loading && !fetchError && links.length > 0 && (
          <LinksTable
            links={links}
            copied={copied}
            onCopy={copyCheckout}
            onCashOut={cashOut}
            cashOutBlocked={cashOutBlocked}
          />
        )}
      </section>

      <section className="panel">
        <h2>Export</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          Download all links as CSV for your accounting. Optionally filter by date range.
        </p>
        <div className="csv-export-row">
          <div className="field csv-field">
            <label htmlFor="csv-from">From</label>
            <input
              id="csv-from"
              type="date"
              value={csvFrom}
              onChange={(e) => setCsvFrom(e.target.value)}
            />
          </div>
          <div className="field csv-field">
            <label htmlFor="csv-to">To</label>
            <input
              id="csv-to"
              type="date"
              value={csvTo}
              onChange={(e) => setCsvTo(e.target.value)}
            />
          </div>
          <button className="btn" onClick={handleCsvExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </section>

      {cashOutQuote && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div className="panel" style={{ width: 400, maxWidth: "90%", margin: 0 }}>
            <h2>Confirm cash out</h2>
            <div className="memo-note" style={{ margin: "24px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span>Gross proceeds</span>
                <span>{cashOutQuote.gross} {cashOutQuote.currency}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span>Fee {cashOutQuote.source === "estimated" ? "(estimated)" : ""}</span>
                <span>-{cashOutQuote.fee} {cashOutQuote.currency}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 8, borderTop: "1px solid var(--border)" }}>
                <strong>Net to bank</strong>
                <strong>{cashOutQuote.net} {cashOutQuote.currency}</strong>
              </div>
            </div>
            <div className="row">
              <button className="btn btn--block" onClick={() => setCashOutQuote(null)}>Cancel</button>
              <button className="btn btn--primary btn--block" onClick={confirmCashOut}>Confirm cash out</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
