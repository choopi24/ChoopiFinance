import { describe, it, expect } from "vitest";
import * as S from "./schemas.js";

/** Convenience: does this payload pass, and if not what did it say? */
const check = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, v: unknown) => {
  const r = schema.safeParse(v);
  if (r.success) return "ok";
  const issues = (r.error as { issues: { path: (string|number)[]; message: string }[] }).issues;
  return issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
};

const tx = (over: Record<string, unknown> = {}) => ({
  account_id: 1, date: "2026-01-31", type: "deposit",
  amount_minor: 100_000, currency: "ILS", ...over,
});

describe("transaction validation", () => {
  it("accepts a well-formed deposit with a contribution split", () => {
    expect(check(S.TransactionCreate, tx({ contribution_part: "employer" }))).toBe("ok");
  });

  it("rejects dates that are not ISO or not real", () => {
    expect(check(S.TransactionCreate, tx({ date: "31/01/2026" }))).toMatch(/YYYY-MM-DD/);
    expect(check(S.TransactionCreate, tx({ date: "2026-02-30" }))).toMatch(/not a real date/);
    expect(check(S.TransactionCreate, tx({ date: "2026-13-01" }))).toMatch(/not a real date/);
    expect(check(S.TransactionCreate, tx({ date: "2026-04-31" }))).toMatch(/not a real date/);
    expect(check(S.TransactionCreate, tx({ date: "2026-1-5" }))).toMatch(/YYYY-MM-DD/);
  });

  it("rejects float money — minor units are whole numbers", () => {
    expect(check(S.TransactionCreate, tx({ amount_minor: 100.5 }))).toMatch(/whole minor units/);
  });

  it("rejects unknown enums", () => {
    expect(check(S.TransactionCreate, tx({ type: "donation" }))).toMatch(/type:/);
    expect(check(S.TransactionCreate, tx({ currency: "EUR" }))).toMatch(/currency:/);
    expect(check(S.TransactionCreate, tx({ contribution_part: "bonus" }))).toMatch(/contribution_part:/);
  });

  it("enforces the sign convention in plain English", () => {
    expect(check(S.TransactionCreate, tx({ amount_minor: -100 }))).toMatch(/deposit brings money in/);
    expect(check(S.TransactionCreate, tx({ type: "fee", amount_minor: 100, fee_kind: "other" })))
      .toMatch(/fee takes money out/);
    expect(check(S.TransactionCreate, tx({ type: "withdrawal", amount_minor: 100 })))
      .toMatch(/withdrawal takes money out/);
  });

  it("a trade must be fully specified; a non-trade must carry no units", () => {
    expect(check(S.TransactionCreate, tx({ type: "buy", amount_minor: -1000 })))
      .toMatch(/needs holding_id, quantity and price_minor/);
    expect(check(S.TransactionCreate,
      tx({ type: "buy", amount_minor: -1000, holding_id: 1, quantity: 5, price_minor: 200 }))).toBe("ok");
    expect(check(S.TransactionCreate, tx({ quantity: 5 })))
      .toMatch(/only buy\/sell carry quantity/);
  });

  it("rejects a non-positive quantity", () => {
    expect(check(S.TransactionCreate,
      tx({ type: "buy", amount_minor: -1000, holding_id: 1, quantity: -5, price_minor: 200 })))
      .toMatch(/greater than zero/);
    expect(check(S.TransactionCreate,
      tx({ type: "buy", amount_minor: -1000, holding_id: 1, quantity: 0, price_minor: 200 })))
      .toMatch(/greater than zero/);
  });

  it("ties fee_kind to fees and contribution_part to deposits", () => {
    expect(check(S.TransactionCreate, tx({ type: "fee", amount_minor: -100 }))).toMatch(/needs a fee_kind/);
    expect(check(S.TransactionCreate, tx({ fee_kind: "trade" }))).toMatch(/fee transactions only/);
    expect(check(S.TransactionCreate, tx({ type: "withdrawal", amount_minor: -100, contribution_part: "employee" })))
      .toMatch(/deposits only/);
  });
});

describe("account and rule validation", () => {
  it("requires a name and known category/mode", () => {
    expect(check(S.AccountCreate, { name: "  ", category: "pension", valuation_mode: "balance" }))
      .toMatch(/name/);
    expect(check(S.AccountCreate, { name: "P", category: "savings", valuation_mode: "balance" }))
      .toMatch(/category/);
    expect(check(S.AccountCreate, { name: "P", category: "pension", valuation_mode: "guess" }))
      .toMatch(/valuation_mode/);
  });

  it("bounds fee percentages", () => {
    expect(check(S.AccountCreate,
      { name: "P", category: "pension", valuation_mode: "balance", mgmt_fee_balance_pct: 150 }))
      .toMatch(/<=100/);
    expect(check(S.AccountCreate,
      { name: "P", category: "pension", valuation_mode: "balance", mgmt_fee_balance_pct: -1 }))
      .toMatch(/>=0/);
    expect(check(S.AccountCreate,
      { name: "P", category: "pension", valuation_mode: "balance", mgmt_fee_balance_pct: null })).toBe("ok");
  });

  it("bounds day_of_month and orders the rule window", () => {
    const rule = (o: Record<string, unknown>) => ({
      account_id: 1, day_of_month: 9, amount_minor: 1000, start_date: "2026-01-01", ...o,
    });
    expect(check(S.RecurringRuleCreate, rule({ day_of_month: 32 }))).toMatch(/<=31/);
    expect(check(S.RecurringRuleCreate, rule({ day_of_month: 0 }))).toMatch(/>=1/);
    expect(check(S.RecurringRuleCreate, rule({ amount_minor: -5 }))).toMatch(/greater than zero/);
    expect(check(S.RecurringRuleCreate, rule({ end_date: "2025-12-01" })))
      .toMatch(/on or after start_date/);
    expect(check(S.RecurringRuleCreate, rule({}))).toBe("ok");
  });

  it("grant cliff cannot exceed the vesting duration", () => {
    const g = (o: Record<string, unknown>) => ({
      account_id: 1, symbol: "acme", grant_date: "2025-01-01", total_units: 100,
      vest_duration_months: 48, vest_frequency: "quarterly", ...o,
    });
    expect(check(S.RsuGrantCreate, g({ cliff_months: 60 }))).toMatch(/cannot exceed/);
    expect(check(S.RsuGrantCreate, g({ cliff_months: 12 }))).toBe("ok");
    // symbols are normalised so the price series keys line up
    const parsed = S.RsuGrantCreate.parse(g({ cliff_months: 12 }));
    expect(parsed.symbol).toBe("ACME");
  });

  it("fx requires two different currencies and a positive rate", () => {
    expect(check(S.FxRateCreate, { date: "2026-01-01", base_currency: "USD", quote_currency: "USD", rate: 1 }))
      .toMatch(/must differ/);
    expect(check(S.FxRateCreate, { date: "2026-01-01", base_currency: "USD", quote_currency: "ILS", rate: 0 }))
      .toMatch(/greater than zero/);
    expect(check(S.FxRateCreate, { date: "2026-01-01", base_currency: "USD", quote_currency: "ILS", rate: 3.7 }))
      .toBe("ok");
  });

  it("a vest cannot sell more units for tax than it releases", () => {
    expect(check(S.RsuVestCreate, { grant_id: 1, vest_date: "2026-01-01", units: 100, units_sold_to_cover_tax: 150 }))
      .toMatch(/cannot exceed units/);
  });
});
