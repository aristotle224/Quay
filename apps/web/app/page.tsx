import Dashboard from "./components/Dashboard";
import WebhooksPanel from "./components/WebhooksPanel";

export default function Page() {
  return (
    <main className="shell">
      <header className="masthead">
        <h1>Stellar Checkout</h1>
        <span className="net">
          <span className="dot" />
          seller dashboard
        </span>
      </header>
      <Dashboard />
      <WebhooksPanel />
    </main>
  );
}
