"use client";

export function ReceiptClient() {
  function handlePrint() {
    window.print();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // fallback
    }
  }

  return (
    <div className="receipt-actions">
      <button className="btn btn--ghost" onClick={handlePrint}>
        🖨️ Print receipt
      </button>
      <button className="btn" onClick={handleCopy}>
        📋 Copy receipt link
      </button>
    </div>
  );
}
