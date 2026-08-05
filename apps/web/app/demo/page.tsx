import Script from "next/script";
import Link from "next/link";

export default function DemoPage() {
  return (
    <main className="shell shell--narrow">
      <header className="masthead">
        <h1>Storefront Demo</h1>
        <span className="net mono">Quay Widget Integration</span>
      </header>

      <div className="panel">
        <h2>Ceramic Artisans Co.</h2>
        <p className="muted" style={{ marginBottom: 20 }}>
          This sample storefront demonstrates integrating Quay Checkout into any third-party HTML website using a single 5KB script tag.
        </p>

        <div style={{ border: "1px solid #30363d", borderRadius: 12, padding: 20, marginBottom: 24, background: "#161b22" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>Handcrafted Ceramic Mug</h3>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>Limited edition matte black ceramic 12oz cup.</p>
            </div>
            <div className="mono" style={{ fontSize: 20, fontWeight: "bold", color: "#2f81f7" }}>
              $25.00 USDC
            </div>
          </div>

          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #30363d", display: "flex", gap: 12, alignItems: "center" }}>
            {/* Embeddable Widget Button */}
            <button
              id="demo-pay-btn"
              className="btn btn--primary"
              data-quay-link="demo_mug_123"
              data-quay-label="Pay $25.00 with Quay"
            >
              Pay $25.00 with Quay
            </button>
            <Link className="linkbtn" href="/">
              Back to dashboard
            </Link>
          </div>
        </div>

        <h3>Integration Snippet</h3>
        <pre style={{ background: "#0d1117", padding: 16, borderRadius: 8, overflowX: "auto", fontSize: 13 }} className="mono">
{`<script src="https://quay-web.vercel.app/widget.js" defer></script>
<button data-quay-link="lnk_123" data-quay-label="Pay $25.00">Pay</button>`}
        </pre>
      </div>

      <Script src="/widget.js" strategy="lazyOnload" />
    </main>
  );
}
