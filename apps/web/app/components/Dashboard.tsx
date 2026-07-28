"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type PaymentLink } from "../../lib/api";

// Mirrors the API's OFFRAMP setting (see .env.example) so this button never
// claims a real payout when the backend is still running MockAnchorOffRamp.
const OFFRAMP_CURRENCY = process.env.NEXT_PUBLIC_OFFRAMP_CURRENCY ?? "NGN";
const OFFRAMP_IS_MOCK = (process.env.NEXT_PUBLIC_OFFRAMP_MODE ?? "mock") !== "testanchor";
const CASH_OUT_LABEL = OFFRAMP_IS_MOCK
  ? `Cash out to ${OFFRAMP_CURRENCY} (simulated)`
  : `Cash out to ${OFFRAMP_CURRENCY}`;

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

export default function Dashboard() {
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [assetCode, setAssetCode] = useState<"USDC" | "XLM">("USDC");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { links } = await api.listLinks();
      setLinks(links);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load links");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function create() {
    setError(null);
    if (!title.trim() || !amount.trim()) {
      setError("Add a title and an amount.");
      return;
    }
    setCreating(true);
    try {
      const { link } = await api.createLink({ title: title.trim(), amount: amount.trim(), assetCode });
      setTitle("");
      setAmount("");
      setLinks((prev) => [link, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create link");
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

  async function cashOut(id: string) {
    setError(null);
    try {
      await api.cashOut(id, OFFRAMP_CURRENCY);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cash-out failed");
    }
  }

  return (
    <>
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
            <select id="asset" value={assetCode} onChange={(e) => setAssetCode(e.target.value as "USDC" | "XLM")}>
              <option value="USDC">USDC</option>
              <option value="XLM">XLM</option>
            </select>
          </div>
        </div>
        <button className="btn btn--primary btn--block" onClick={create} disabled={creating}>
          {creating ? "Creating…" : "Create link"}
        </button>
        {error && <div className="err">{error}</div>}
      </section>

      <section className="panel">
        <h2>Links</h2>
        {links.length === 0 ? (
          <div className="empty">No links yet. Create one above to get a checkout page.</div>
        ) : (
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
                    {link.title}
                    {link.isDemo && <> <DemoBadge /></>}
                  </td>
                  <td className="amt">{amountLabel(link)}</td>
                  <td><StatusPill status={link.status} /></td>
                  <td className="hide-sm"><span className="mono muted">{link.reference}</span></td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="linkbtn" onClick={() => copyCheckout(link.id)}>
                      {copied === link.id ? "Copied" : "Copy link"}
                    </button>
                    {link.status === "paid" && (
                      <>
                        {" · "}
                        <button className="linkbtn" onClick={() => cashOut(link.id)}>
                          {CASH_OUT_LABEL}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
