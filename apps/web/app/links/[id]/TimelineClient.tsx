"use client";

import { useState } from "react";

export function TimelineClient({
  linkId,
  reference,
}: {
  linkId: string;
  reference: string;
}) {
  const [copied, setCopied] = useState(false);

  const receiptUrl = `${window.location.origin}/r/${reference}`;

  async function copyLink() {
    await navigator.clipboard.writeText(receiptUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="tl-receipt-row">
      <code className="mono tl-receipt-url">{receiptUrl}</code>
      <button className="btn" onClick={copyLink}>
        {copied ? "Copied!" : "Copy receipt link"}
      </button>
    </div>
  );
}
