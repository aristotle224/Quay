"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { api, type Webhook, type WebhookDelivery } from "../../lib/api";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** A secret shown exactly once, right after create/rotate. */
function OneTimeSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="panel" style={{ borderColor: "var(--accent)" }}>
      <h2>New signing secret — copy it now</h2>
      <p className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 12 }}>
        This is shown once and can&apos;t be retrieved again. If you lose it, rotate the secret to get a new one.
      </p>
      <div className="mono" style={{ wordBreak: "break-all", padding: "10px 12px", background: "var(--bg)", borderRadius: 8, marginBottom: 12 }}>
        {secret}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn--primary" onClick={copy}>
          {copied ? "Copied" : "Copy secret"}
        </button>
        <button className="btn" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}

function DeliveriesTable({ webhookId }: { webhookId: string }) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listWebhookDeliveries(webhookId, { limit: 10, cursor: after });
        setDeliveries((prev) => (after ? [...prev, ...result.deliveries] : result.deliveries));
        setNextCursor(result.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load deliveries");
      } finally {
        setLoading(false);
      }
    },
    [webhookId],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  if (loading && deliveries.length === 0) return <div className="empty">Loading deliveries…</div>;
  if (error) return <div className="err">{error}</div>;
  if (deliveries.length === 0) return <div className="empty">No deliveries yet.</div>;

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Status</th>
            <th className="hide-sm">Time</th>
            <th className="hide-sm">Detail</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td className="mono">{d.event}</td>
              <td>
                <span className={`pill pill--${d.ok ? "ok" : "fail"}`}>
                  {d.statusCode ?? "no response"}
                </span>
              </td>
              <td className="hide-sm muted">{formatDate(d.createdAt)}</td>
              <td className="hide-sm muted">{d.error ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {nextCursor && (
        <button
          className="linkbtn"
          style={{ marginTop: 10 }}
          onClick={() => {
            setCursor(nextCursor);
            void load(nextCursor);
          }}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </>
  );
}

export default function WebhooksPanel() {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { webhooks } = await api.listWebhooks();
      setHooks(webhooks);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load webhooks");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    setError(null);
    if (!url.trim()) {
      setError("Add an endpoint URL.");
      return;
    }
    setCreating(true);
    try {
      const hook = await api.createWebhook(url.trim());
      setUrl("");
      setRevealedSecret(hook.secret);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create webhook");
    } finally {
      setCreating(false);
    }
  }

  async function rotate(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const hook = await api.rotateWebhookSecret(id);
      setRevealedSecret(hook.secret);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rotate secret");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!confirm("Remove this webhook? Its delivery history stays visible, but it will stop receiving events.")) {
      return;
    }
    setError(null);
    setBusyId(id);
    try {
      await api.deleteWebhook(id);
      if (expandedId === id) setExpandedId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove webhook");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="panel">
        <h2>Webhooks</h2>
        <div className="field">
          <label htmlFor="webhook-url">Endpoint URL</label>
          <input
            id="webhook-url"
            className="mono"
            placeholder="https://your-server.example.com/webhooks/quay"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <button className="btn btn--primary btn--block" onClick={create} disabled={creating}>
          {creating ? "Adding…" : "Add endpoint"}
        </button>
        {error && <div className="err">{error}</div>}
      </section>

      {revealedSecret && <OneTimeSecret secret={revealedSecret} onDismiss={() => setRevealedSecret(null)} />}

      <section className="panel">
        <h2>Registered endpoints</h2>
        {hooks.length === 0 ? (
          <div className="empty">No webhooks yet. Add one above to start receiving events.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>URL</th>
                <th className="hide-sm">Secret</th>
                <th className="hide-sm">Added</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {hooks.map((hook) => (
                <Fragment key={hook.id}>
                  <tr>
                    <td className="mono">{hook.url}</td>
                    <td className="hide-sm mono muted">
                      ····{hook.secretLast4}
                      {hook.previousSecretLast4 &&
                        hook.previousSecretExpiresAt &&
                        hook.previousSecretExpiresAt > Date.now() && (
                          <span className="pill pill--none" style={{ marginLeft: 6 }}>
                            rotating — old key active until {formatDate(hook.previousSecretExpiresAt)}
                          </span>
                        )}
                    </td>
                    <td className="hide-sm muted">{formatDate(hook.createdAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="linkbtn"
                        onClick={() => setExpandedId((cur) => (cur === hook.id ? null : hook.id))}
                      >
                        {expandedId === hook.id ? "Hide deliveries" : "Deliveries"}
                      </button>
                      {" · "}
                      <button className="linkbtn" onClick={() => rotate(hook.id)} disabled={busyId === hook.id}>
                        Rotate secret
                      </button>
                      {" · "}
                      <button className="linkbtn" onClick={() => remove(hook.id)} disabled={busyId === hook.id}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {expandedId === hook.id && (
                    <tr>
                      <td colSpan={4} style={{ background: "var(--bg)", padding: 16 }}>
                        <DeliveriesTable webhookId={hook.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
