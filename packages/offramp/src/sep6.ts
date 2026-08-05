import type { Logger } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

export interface Sep6WithdrawResult {
  id: string;
  accountId?: string;
}

export interface Sep6TransactionResult {
  id: string;
  status: string;
  amountOut?: string;
  message?: string;
}

/** SEP-6: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0006.md */
export async function startSep6Withdraw(
  baseUrl: string,
  jwt: string,
  input: {
    assetCode: string;
    amount: string;
    account: string;
    type: string;
    dest?: string;
    destExtra?: string;
  },
  logger?: Logger,
): Promise<Sep6WithdrawResult> {
  const log = (logger ?? NOOP_LOGGER).child({ component: "sep6", baseUrl });
  const url = new URL("/sep6/withdraw", baseUrl);
  url.searchParams.set("asset_code", input.assetCode);
  url.searchParams.set("amount", input.amount);
  url.searchParams.set("account", input.account);
  url.searchParams.set("type", input.type);
  if (input.dest) url.searchParams.set("dest", input.dest);
  if (input.destExtra) url.searchParams.set("dest_extra", input.destExtra);

  const t0 = Date.now();
  log.info(
    {
      event: "anchor.sep6.withdraw.start",
      assetCode: input.assetCode,
      amount: input.amount,
      account: input.account,
      type: input.type,
    },
    "starting SEP-6 withdraw",
  );
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    log.warn({ event: "anchor.sep6.withdraw.fail", statusCode: res.status, durationMs: Date.now() - t0 }, "SEP-6 withdraw failed");
    throw new Error(`SEP-6 withdraw failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; account_id?: string };
  const out: Sep6WithdrawResult = { id: body.id, accountId: body.account_id };
  log.info(
    { event: "anchor.sep6.withdraw.ok", withdrawId: out.id, accountId: out.accountId, durationMs: Date.now() - t0 },
    "SEP-6 withdraw started",
  );
  return out;
}

export async function getSep6Transaction(
  baseUrl: string,
  jwt: string,
  id: string,
  logger?: Logger,
): Promise<Sep6TransactionResult> {
  const log = (logger ?? NOOP_LOGGER).child({ component: "sep6", baseUrl, transactionId: id });
  const url = new URL("/sep6/transaction", baseUrl);
  url.searchParams.set("id", id);

  const t0 = Date.now();
  const res = await fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
  if (!res.ok) {
    log.warn({ event: "anchor.sep6.status.fail", statusCode: res.status, durationMs: Date.now() - t0 }, "SEP-6 transaction fetch failed");
    throw new Error(`SEP-6 transaction fetch failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    transaction: { id: string; status: string; amount_out?: string; message?: string };
  };
  const out: Sep6TransactionResult = {
    id: body.transaction.id,
    status: body.transaction.status,
    amountOut: body.transaction.amount_out,
    message: body.transaction.message,
  };
  log.info(
    { event: "anchor.sep6.status.ok", status: out.status, amountOut: out.amountOut, durationMs: Date.now() - t0 },
    "SEP-6 transaction polled",
  );
  return out;
}
