/**
 * Input validation for every write. Money arrives as INTEGER minor units and is
 * validated as such — the API never accepts a float for money, so no rounding
 * decision is ever made implicitly on the way in.
 */

import { z } from "zod";

/**
 * An ISO date that is also a REAL date. `Date.parse` alone is not enough:
 * "2026-02-30" parses happily and silently rolls to March 2, so the parsed
 * value is round-tripped back to a string and compared.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
  .refine(s => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a real date (check the day of the month)");

/** Money: whole minor units only. */
const minor = z.number().int("money must be whole minor units (agorot/cents)");
const minorPositive = minor.positive("must be greater than zero");
const minorNonNeg = minor.nonnegative();

const currency = z.enum(["ILS", "USD"]);
const quantity = z.number().finite().positive("quantity must be greater than zero");
const pct = z.number().finite().min(0).max(100).nullable().optional();

export const AccountCreate = z.object({
  name: z.string().trim().min(1, "name is required"),
  institution: z.string().trim().nullish(),
  category: z.enum(["stock", "etf", "crypto", "keren_hishtalmut", "pension",
                    "gemel_lehashkaa", "rsu", "cash"]),
  valuation_mode: z.enum(["market", "balance"]),
  currency: currency.default("ILS"),
  funding_mode: z.enum(["manual", "salary", "passive"]).default("manual"),
  mgmt_fee_balance_pct: pct,
  mgmt_fee_deposit_pct: pct,
  is_active: z.union([z.boolean(), z.literal(0), z.literal(1)]).default(true),
  notes: z.string().trim().nullish(),
});
export const AccountUpdate = AccountCreate.partial();

export const HoldingCreate = z.object({
  account_id: z.number().int().positive(),
  symbol: z.string().trim().min(1).transform(s => s.toUpperCase()),
  display_name: z.string().trim().nullish(),
  asset_class: z.enum(["stock", "etf", "crypto"]),
  currency: currency.default("ILS"),
});
export const HoldingUpdate = HoldingCreate.partial().omit({ account_id: true });

export const PriceCreate = z.object({
  holding_id: z.number().int().positive(),
  date: isoDate,
  price_minor: minorNonNeg,
  currency: currency.default("ILS"),
});
export const PriceUpdate = PriceCreate.partial().omit({ holding_id: true });

/**
 * Transactions carry the sign convention the DB enforces, so the API normalises
 * it rather than letting a caller post a positive fee that the CHECK rejects
 * with a cryptic message.
 */
export const TransactionCreate = z.object({
  account_id: z.number().int().positive(),
  holding_id: z.number().int().positive().nullish(),
  date: isoDate,
  type: z.enum(["deposit", "withdrawal", "buy", "sell", "fee", "dividend", "adjustment"]),
  amount_minor: minor,
  quantity: quantity.nullish(),
  price_minor: minorNonNeg.nullish(),
  contribution_part: z.enum(["employee", "employer", "severance"]).nullish(),
  fee_kind: z.enum(["management_balance", "management_deposit", "trade", "other"]).nullish(),
  currency: currency.default("ILS"),
  note: z.string().trim().nullish(),
}).superRefine((v, ctx) => {
  const needsUnits = v.type === "buy" || v.type === "sell";
  if (needsUnits && (v.holding_id == null || v.quantity == null || v.price_minor == null)) {
    ctx.addIssue({ code: "custom", message: `${v.type} needs holding_id, quantity and price_minor` });
  }
  if (!needsUnits && (v.quantity != null || v.price_minor != null)) {
    ctx.addIssue({ code: "custom", message: "only buy/sell carry quantity and price_minor" });
  }
  if (v.type === "fee" && v.fee_kind == null) {
    ctx.addIssue({ code: "custom", message: "a fee needs a fee_kind" });
  }
  if (v.type !== "fee" && v.fee_kind != null) {
    ctx.addIssue({ code: "custom", message: "fee_kind belongs to fee transactions only" });
  }
  if (v.type !== "deposit" && v.contribution_part != null) {
    ctx.addIssue({ code: "custom", message: "contribution_part describes deposits only" });
  }
  if (v.amount_minor === 0 && v.type !== "adjustment") {
    ctx.addIssue({ code: "custom", message: "amount_minor must not be zero" });
  }
  // Mirror the DB's sign convention here so a wrong sign reads as plain English
  // instead of surfacing a raw CHECK-constraint message.
  const wantsPositive = ["deposit", "sell", "dividend"];
  const wantsNegative = ["withdrawal", "buy", "fee"];
  if (wantsPositive.includes(v.type) && v.amount_minor < 0) {
    ctx.addIssue({ code: "custom",
      message: `a ${v.type} brings money in, so amount_minor must be positive` });
  }
  if (wantsNegative.includes(v.type) && v.amount_minor > 0) {
    ctx.addIssue({ code: "custom",
      message: `a ${v.type} takes money out, so amount_minor must be negative` });
  }
});
export const TransactionUpdate = z.object({
  date: isoDate.optional(),
  type: z.enum(["deposit", "withdrawal", "buy", "sell", "fee", "dividend", "adjustment"]).optional(),
  amount_minor: minor.optional(),
  quantity: quantity.nullish(),
  price_minor: minorNonNeg.nullish(),
  holding_id: z.number().int().positive().nullish(),
  contribution_part: z.enum(["employee", "employer", "severance"]).nullish(),
  fee_kind: z.enum(["management_balance", "management_deposit", "trade", "other"]).nullish(),
  currency: currency.optional(),
  note: z.string().trim().nullish(),
});

export const ValuationCreate = z.object({
  account_id: z.number().int().positive(),
  date: isoDate,
  balance_minor: minorNonNeg,
  currency: currency.default("ILS"),
});
export const ValuationUpdate = ValuationCreate.partial().omit({ account_id: true });

export const RecurringRuleCreate = z.object({
  account_id: z.number().int().positive(),
  label: z.string().trim().nullish(),
  frequency: z.enum(["monthly", "quarterly", "annual"]).default("monthly"),
  day_of_month: z.number().int().min(1).max(31),
  amount_minor: minorPositive,
  currency: currency.default("ILS"),
  contribution_part: z.enum(["employee", "employer", "severance"]).nullish(),
  start_date: isoDate,
  end_date: isoDate.nullish(),
  auto_generate: z.union([z.boolean(), z.literal(0), z.literal(1)]).default(true),
  is_active: z.union([z.boolean(), z.literal(0), z.literal(1)]).default(true),
}).superRefine((v, ctx) => {
  if (v.end_date && v.end_date < v.start_date) {
    ctx.addIssue({ code: "custom", message: "end_date must be on or after start_date" });
  }
});
export const RecurringRuleUpdate = z.object({
  label: z.string().trim().nullish(),
  frequency: z.enum(["monthly", "quarterly", "annual"]).optional(),
  day_of_month: z.number().int().min(1).max(31).optional(),
  amount_minor: minorPositive.optional(),
  currency: currency.optional(),
  contribution_part: z.enum(["employee", "employer", "severance"]).nullish(),
  start_date: isoDate.optional(),
  end_date: isoDate.nullish(),
  auto_generate: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  is_active: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  last_generated_date: isoDate.nullish(),
});

export const FxRateCreate = z.object({
  date: isoDate,
  base_currency: currency,
  quote_currency: currency,
  rate: z.number().finite().positive("rate must be greater than zero"),
}).superRefine((v, ctx) => {
  if (v.base_currency === v.quote_currency) {
    ctx.addIssue({ code: "custom", message: "base and quote must differ" });
  }
});
export const FxRateUpdate = z.object({ rate: z.number().finite().positive("rate must be greater than zero") });

export const RsuGrantCreate = z.object({
  account_id: z.number().int().positive(),
  symbol: z.string().trim().min(1).transform(s => s.toUpperCase()),
  grant_date: isoDate,
  total_units: quantity,
  grant_price_minor: minorNonNeg.nullish(),
  currency: currency.default("USD"),
  cliff_months: z.number().int().min(0).default(0),
  vest_duration_months: z.number().int().positive(),
  vest_frequency: z.enum(["monthly", "quarterly", "annual"]),
  notes: z.string().trim().nullish(),
}).superRefine((v, ctx) => {
  if (v.cliff_months > v.vest_duration_months) {
    ctx.addIssue({ code: "custom", message: "cliff_months cannot exceed vest_duration_months" });
  }
});
export const RsuGrantUpdate = z.object({
  symbol: z.string().trim().min(1).transform(s => s.toUpperCase()).optional(),
  grant_date: isoDate.optional(),
  total_units: quantity.optional(),
  grant_price_minor: minorNonNeg.nullish(),
  cliff_months: z.number().int().min(0).optional(),
  vest_duration_months: z.number().int().positive().optional(),
  vest_frequency: z.enum(["monthly", "quarterly", "annual"]).optional(),
  notes: z.string().trim().nullish(),
});

export const RsuVestCreate = z.object({
  grant_id: z.number().int().positive(),
  vest_date: isoDate,
  units: quantity,
  price_at_vest_minor: minorNonNeg.nullish(),
  units_sold_to_cover_tax: z.number().finite().min(0).default(0),
  status: z.enum(["scheduled", "vested", "cancelled"]).default("scheduled"),
}).superRefine((v, ctx) => {
  if (v.units_sold_to_cover_tax > v.units) {
    ctx.addIssue({ code: "custom", message: "units_sold_to_cover_tax cannot exceed units" });
  }
});
export const RsuVestUpdate = z.object({
  vest_date: isoDate.optional(),
  units: quantity.optional(),
  price_at_vest_minor: minorNonNeg.nullish(),
  units_sold_to_cover_tax: z.number().finite().min(0).optional(),
  status: z.enum(["scheduled", "vested", "cancelled"]).optional(),
});

export const SettingUpsert = z.object({
  key: z.string().trim().min(1),
  value: z.string(),
});

/** Query params shared by the read endpoints. */
export const AsOfQuery = z.object({
  as_of: isoDate.optional(),
  currency: currency.optional(),
});
export const SeriesQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  granularity: z.enum(["daily", "monthly"]).default("monthly"),
  currency: currency.optional(),
});
