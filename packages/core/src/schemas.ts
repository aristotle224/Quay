import { z } from "zod";
import { isValidAmount } from "./domain/money";

// Asset is restricted to a small allowlist for the MVP: USDC (issued) or native XLM.
// The issuer for USDC is resolved server-side from config, so the client only
// names the asset code.
export const assetCodeSchema = z.enum(["USDC", "XLM"]);

export const createLinkSchema = z.object({
  title: z.string().trim().min(1).max(120),
  amount: z
    .string()
    .trim()
    .refine(isValidAmount, "amount must be a positive number with at most 7 decimals"),
  assetCode: assetCodeSchema.default("USDC"),
  // optional time-to-live in minutes; omitted => no expiry
  expiresInMinutes: z.number().int().positive().max(60 * 24 * 30).optional(),
  /** Internal flag set by the demo seed script. */
  isDemo: z.boolean().optional(),
});
export type CreateLinkBody = z.infer<typeof createLinkSchema>;

export const registerWebhookSchema = z.object({
  url: z.string().url(),
});
export type RegisterWebhookBody = z.infer<typeof registerWebhookSchema>;

export const listWebhookDeliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().trim().min(1).optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;

export const cashOutSchema = z.object({
  targetCurrency: z.string().trim().length(3).toUpperCase().default("NGN"),
  // Opaque payout fields handed to the anchor adapter (e.g. bank, account number).
  payoutFields: z.record(z.string(), z.string()).default({}),
});
export type CashOutBody = z.infer<typeof cashOutSchema>;
