import type { AssetRef } from "@checkout/core";

export interface Sep38QuoteResult {
  id: string;
  price: string;
  sellAmount: string;
  buyAmount: string;
  expiresAt: string; // ISO 8601
}

/** One entry from GET /sep38/prices — indicative, no commitment. */
export interface Sep38PriceEntry {
  /** ISO-4217 currency code, e.g. "NGN". */
  buyCurrency: string;
  /** Indicative sell_amount / buy_amount exchange rate. */
  price: string;
  /** Available delivery methods (e.g. "WIRE", "BANK_TRANSFER"). May be empty. */
  deliveryMethods: string[];
}

function assetIdentifier(asset: AssetRef): string {
  // SEP-38 asset identification format: native XLM is "stellar:native".
  return asset.issuer === null ? "stellar:native" : `stellar:${asset.code}:${asset.issuer}`;
}

/**
 * SEP-38 GET /prices — indicative, unauthenticated, no quote consumed.
 *
 * Returns available buy currencies with indicative rates for the given sell
 * asset and amount. Use this for dashboards / corridor comparison (issue 3.5).
 * Call getSep38Quote() only when the seller commits to a cash-out.
 *
 * SEP-38 spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md#get-prices
 */
export async function getSep38Prices(
  baseUrl: string,
  input: { sellAsset: AssetRef; sellAmount: string },
): Promise<Sep38PriceEntry[]> {
  const url = new URL("/sep38/prices", baseUrl);
  url.searchParams.set("sell_asset", assetIdentifier(input.sellAsset));
  url.searchParams.set("sell_amount", input.sellAmount);
  // context=sep6 matches how we use the firm quote endpoint — keeps the anchor
  // consistent about which corridors it surfaces.
  url.searchParams.set("context", "sep6");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SEP-38 /prices failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    buy_assets: Array<{
      asset: string; // e.g. "iso4217:NGN"
      price: string;
      decimals?: number;
      buy_delivery_methods?: Array<{ name: string; description?: string }>;
    }>;
  };

  return (body.buy_assets ?? []).flatMap((entry) => {
    // Only surface fiat ISO-4217 entries ("iso4217:XXX").
    const match = entry.asset.match(/^iso4217:([A-Z]{3})$/);
    if (!match || !match[1]) return [];
    const buyCurrency: string = match[1];
    return [
      {
        buyCurrency,
        price: entry.price,
        deliveryMethods: (entry.buy_delivery_methods ?? []).map((m) => m.name),
      },
    ];
  });
}

/** SEP-38: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md */
export async function getSep38Quote(
  baseUrl: string,
  jwt: string,
  input: { sellAsset: AssetRef; sellAmount: string; buyCurrency: string },
): Promise<Sep38QuoteResult> {
  const res = await fetch(new URL("/sep38/quote", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      sell_asset: assetIdentifier(input.sellAsset),
      sell_amount: input.sellAmount,
      buy_asset: `iso4217:${input.buyCurrency}`,
      buy_delivery_method: "WIRE",
      context: "sep6",
    }),
  });
  if (!res.ok) {
    throw new Error(`SEP-38 quote failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    id: string;
    price: string;
    sell_amount: string;
    buy_amount: string;
    expires_at: string;
  };
  return {
    id: body.id,
    price: body.price,
    sellAmount: body.sell_amount,
    buyAmount: body.buy_amount,
    expiresAt: body.expires_at,
  };
}
