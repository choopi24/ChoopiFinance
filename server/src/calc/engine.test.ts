import { describe, it, expect } from "vitest";
import {
  accountValueOn, netPrincipalOn, feesPaidOn, feesEstimatedOn, unitsHeldOn,
  unvestedUnitsOn, summarizeAccount, summarizePortfolio, accountSeries, priceOn,
} from "./engine.js";
import { resolveFx } from "./fx.js";
import { toMinor } from "./money.js";
import { DEFAULT_OPTIONS, type AccountRow, type Ledger } from "./types.js";

// ── fixture builders ─────────────────────────────────────────────────────────

const M = toMinor; // ₪1,234.56 → 123456

function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    accounts: [], holdings: [], prices: [], transactions: [],
    valuations: [], fx: [], grants: [], vests: [], ...over,
  };
}

function acct(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 1, name: "Test", institution: null, category: "pension",
    valuation_mode: "balance", currency: "ILS", funding_mode: "manual",
    mgmt_fee_balance_pct: null, mgmt_fee_deposit_pct: null, is_active: 1, notes: null,
    ...over,
  };
}

let txId = 0;
function tx(over: Partial<Ledger["transactions"][0]>): Ledger["transactions"][0] {
  return {
    id: ++txId, account_id: 1, holding_id: null, date: "2026-01-01",
    type: "deposit", amount_minor: 0, quantity: null, price_minor: null,
    contribution_part: null, fee_kind: null, currency: "ILS",
    source: "manual", recurring_rule_id: null, ...over,
  } as Ledger["transactions"][0];
}

/** The identity every scenario must satisfy. */
function expectIdentity(s: {
  value_minor: number; net_principal_minor: number;
  net_earnings_minor: number; gross_earnings_minor: number; fees_paid_minor: number;
}) {
  expect(s.net_principal_minor + s.net_earnings_minor).toBe(s.value_minor);
  expect(s.gross_earnings_minor).toBe(s.net_earnings_minor + s.fees_paid_minor);
}

// ── VALUE ────────────────────────────────────────────────────────────────────

describe("value on date D", () => {
  it("balance mode: the last snapshot on-or-before D, carried forward", () => {
    const a = acct();
    const l = ledger({
      accounts: [a],
      valuations: [
        { account_id: 1, date: "2026-01-31", balance_minor: M(100_000), currency: "ILS" },
        { account_id: 1, date: "2026-06-30", balance_minor: M(130_000), currency: "ILS" },
      ],
    });
    expect(accountValueOn(l, a, "2026-01-30").flags).toContain("no_data");
    expect(accountValueOn(l, a, "2026-01-31").value_minor).toBe(M(100_000));
    expect(accountValueOn(l, a, "2026-03-15").value_minor).toBe(M(100_000)); // carried
    expect(accountValueOn(l, a, "2026-06-30").value_minor).toBe(M(130_000)); // inclusive
    expect(accountValueOn(l, a, "2027-01-01").value_minor).toBe(M(130_000));
  });

  it("market mode: units × last price, plus uninvested cash", () => {
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      transactions: [
        tx({ type: "deposit", amount_minor: M(10_000), currency: "USD" }),
        tx({ type: "buy", holding_id: 10, date: "2026-01-15", quantity: 20,
             price_minor: M(480), amount_minor: -M(9_600), currency: "USD" }),
      ],
      prices: [{ holding_id: 10, date: "2026-01-31", price_minor: M(500), currency: "USD" }],
    });
    const v = accountValueOn(l, a, "2026-06-30");
    expect(v.holdings_value_minor).toBe(M(10_000)); // 20 × $500
    expect(v.cash_minor).toBe(M(400));              // $10,000 − $9,600
    expect(v.value_minor).toBe(M(10_400));
  });

  it("no data on-or-before D → contributes 0 and is flagged", () => {
    const a = acct();
    const v = accountValueOn(ledger({ accounts: [a] }), a, "2026-06-30");
    expect(v.value_minor).toBe(0);
    expect(v.flags).toContain("no_data");
  });

  it("market units with no price entered → flagged, not silently zero-priced", () => {
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "X", display_name: null, asset_class: "stock", currency: "USD" }],
      transactions: [tx({ type: "buy", holding_id: 10, quantity: 5, price_minor: M(100),
                          amount_minor: -M(500), currency: "USD" })],
    });
    const v = accountValueOn(l, a, "2026-06-30");
    expect(v.flags).toContain("missing_price");
    expect(v.holdings_value_minor).toBe(0);
  });

  it("flags stale data when the newest reading is older than the threshold", () => {
    const a = acct();
    const l = ledger({
      accounts: [a],
      valuations: [{ account_id: 1, date: "2026-01-01", balance_minor: M(1_000), currency: "ILS" }],
    });
    expect(accountValueOn(l, a, "2026-01-20").flags).not.toContain("stale_data");
    expect(accountValueOn(l, a, "2026-06-01").flags).toContain("stale_data");
  });
});

// ── PRINCIPAL vs EARNINGS ────────────────────────────────────────────────────

describe("net principal vs earnings", () => {
  it("only boundary-crossing flows count: deposits in, withdrawals out", () => {
    const a = acct();
    const l = ledger({
      accounts: [a],
      transactions: [
        tx({ type: "deposit",    date: "2026-01-01", amount_minor:  M(100_000) }),
        tx({ type: "deposit",    date: "2026-03-01", amount_minor:  M(10_000) }),
        tx({ type: "withdrawal", date: "2026-04-01", amount_minor: -M(5_000) }),
        tx({ type: "dividend",   date: "2026-05-01", amount_minor:  M(300) }),   // earnings
        tx({ type: "fee",        date: "2026-05-01", amount_minor: -M(700), fee_kind: "management_balance" }),
      ],
      valuations: [{ account_id: 1, date: "2026-06-30", balance_minor: M(118_000), currency: "ILS" }],
    });
    expect(netPrincipalOn(l, "2026-06-30")).toBe(M(105_000));
    expect(netPrincipalOn(l, "2026-02-01")).toBe(M(100_000)); // as-of respected
    expect(feesPaidOn(l, "2026-06-30")).toBe(M(700));

    const s = summarizeAccount(l, a, "2026-06-30", "ILS");
    expect(s.net_earnings_minor).toBe(M(13_000));         // 118,000 − 105,000
    expect(s.gross_earnings_minor).toBe(M(13_700));       // + the fees paid
    expectIdentity(s);
  });

  it("a withdrawal never manufactures principal via the implied-deposit rule", () => {
    // Regression: the implied-deposit rule reads a negative cash balance as
    // "buys came out of pocket". A withdrawal also drives cash negative, and
    // counting THAT as an implied deposit inflated principal by the amount
    // withdrawn — reporting money as still invested after it had been taken out.
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      transactions: [
        tx({ type: "deposit", date: "2026-01-10", amount_minor: M(1_000), currency: "USD" }),
        tx({ type: "buy", holding_id: 10, date: "2026-01-15", quantity: 2,
             price_minor: M(450), amount_minor: -M(900), currency: "USD" }),
        tx({ type: "withdrawal", date: "2026-01-20", amount_minor: -M(500), currency: "USD" }),
      ],
      prices: [{ holding_id: 10, date: "2026-01-31", price_minor: M(500), currency: "USD" }],
    });

    // 1,000 in, 500 back out. The buy was funded by the deposit.
    expect(netPrincipalOn(l, "2026-02-01")).toBe(M(500));

    const s = summarizeAccount(l, a, "2026-02-01", "USD");
    expect(s.value_minor).toBe(M(1_000));      // 2 × 500 of shares, no cash left
    expect(s.net_earnings_minor).toBe(M(500)); // 1,000 held − 500 net contributed
    expectIdentity(s);
  });

  it("reports no return percentage once more has been withdrawn than paid in", () => {
    // Regression: with principal negative, earnings/principal inverts, and a
    // real gain printed as a large negative percentage.
    const a = acct();
    const l = ledger({
      accounts: [a],
      transactions: [
        tx({ type: "deposit",    date: "2026-01-10", amount_minor:  M(10_000) }),
        tx({ type: "withdrawal", date: "2026-02-10", amount_minor: -M(30_000) }),
      ],
      valuations: [{ account_id: 1, date: "2026-01-31", balance_minor: M(10_500), currency: "ILS" }],
    });

    const s = summarizeAccount(l, a, "2026-06-30", "ILS");
    expect(s.net_principal_minor).toBe(-M(20_000));
    // 30,000 taken out + 10,500 still held − 10,000 ever paid in.
    expect(s.net_earnings_minor).toBe(M(30_500));
    expect(s.simple_return_pct).toBeNull();
    expectIdentity(s);
  });

  it("still counts an unfunded buy as principal", () => {
    // The rule the fix above must not break: shares bought with no recorded
    // deposit really did come out of pocket.
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      transactions: [
        tx({ type: "buy", holding_id: 10, date: "2026-01-15", quantity: 2,
             price_minor: M(450), amount_minor: -M(900), currency: "USD" }),
      ],
      prices: [{ holding_id: 10, date: "2026-01-31", price_minor: M(500), currency: "USD" }],
    });
    expect(netPrincipalOn(l, "2026-02-01")).toBe(M(900));
  });

  it("a buy does NOT add principal when a deposit already funded it", () => {
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      transactions: [
        tx({ type: "deposit", date: "2026-01-10", amount_minor: M(10_000), currency: "USD" }),
        tx({ type: "buy", holding_id: 10, date: "2026-01-15", quantity: 20,
             price_minor: M(480), amount_minor: -M(9_600), currency: "USD" }),
        tx({ type: "fee", date: "2026-01-15", amount_minor: -M(1), fee_kind: "trade", currency: "USD" }),
      ],
      prices: [{ holding_id: 10, date: "2026-01-31", price_minor: M(480), currency: "USD" }],
    });
    // Principal is the deposit only — not deposit + buy.
    expect(netPrincipalOn(l, "2026-02-01")).toBe(M(10_000));
    const s = summarizeAccount(l, a, "2026-02-01", "USD");
    expect(s.value_minor).toBe(M(9_999));        // 9,600 of shares + 399 cash
    expect(s.net_earnings_minor).toBe(-M(1));    // exactly the fee
    expect(s.gross_earnings_minor).toBe(0);      // gross of fees: flat
    expectIdentity(s);
  });

  it("a buy with no funding deposit is treated as money from your pocket", () => {
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      transactions: [
        tx({ type: "buy", holding_id: 10, date: "2026-01-15", quantity: 20,
             price_minor: M(480), amount_minor: -M(9_600), currency: "USD" }),
        tx({ type: "fee", date: "2026-01-15", amount_minor: -M(1), fee_kind: "trade", currency: "USD" }),
      ],
      prices: [{ holding_id: 10, date: "2026-01-31", price_minor: M(480), currency: "USD" }],
    });
    expect(netPrincipalOn(l, "2026-02-01")).toBe(M(9_601));
    const s = summarizeAccount(l, a, "2026-02-01", "USD");
    expect(s.cash_minor).toBe(0);              // floored, not negative
    expect(s.value_minor).toBe(M(9_600));
    expect(s.net_earnings_minor).toBe(-M(1));
    expectIdentity(s);
  });

  it("selling returns principal without inventing earnings", () => {
    const a = acct({ valuation_mode: "market", currency: "USD" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      transactions: [
        tx({ type: "deposit", date: "2026-01-10", amount_minor: M(10_000), currency: "USD" }),
        tx({ type: "buy", holding_id: 10, date: "2026-01-15", quantity: 20,
             price_minor: M(500), amount_minor: -M(10_000), currency: "USD" }),
        tx({ type: "sell", holding_id: 10, date: "2026-03-15", quantity: 5,
             price_minor: M(600), amount_minor: M(3_000), currency: "USD" }),
      ],
      prices: [{ holding_id: 10, date: "2026-03-31", price_minor: M(600), currency: "USD" }],
    });
    // 15 shares @ $600 = 9,000, plus 3,000 cash from the sale = 12,000
    const s = summarizeAccount(l, a, "2026-03-31", "USD");
    expect(s.value_minor).toBe(M(12_000));
    expect(s.net_principal_minor).toBe(M(10_000));
    expect(s.net_earnings_minor).toBe(M(2_000));
    expectIdentity(s);
  });
});

// ── FEES ─────────────────────────────────────────────────────────────────────

describe("fees", () => {
  it("estimates a deposit fee from mgmt_fee_deposit_pct", () => {
    const a = acct({ mgmt_fee_deposit_pct: 1.5 });
    const l = ledger({
      accounts: [a],
      transactions: [
        tx({ type: "deposit", date: "2026-01-09", amount_minor: M(4_000) }),
        tx({ type: "deposit", date: "2026-02-09", amount_minor: M(4_000) }),
      ],
    });
    // 1.5 % of 8,000 = 120
    expect(feesEstimatedOn(l, a, "2026-02-28")).toBe(M(120));
  });

  it("estimates a balance fee monthly from the annual percentage", () => {
    const a = acct({ mgmt_fee_balance_pct: 1.2 });
    const l = ledger({
      accounts: [a],
      valuations: [{ account_id: 1, date: "2026-01-31", balance_minor: M(120_000), currency: "ILS" }],
    });
    // 1.2 %/yr on 120,000 = 120/month; Jan, Feb, Mar → 360
    expect(feesEstimatedOn(l, a, "2026-03-31")).toBe(M(360));
  });

  it("the estimate is independent of recorded fees — it cannot feed on itself", () => {
    const a = acct({ mgmt_fee_balance_pct: 1.2 });
    const base = {
      accounts: [a],
      valuations: [{ account_id: 1, date: "2026-01-31", balance_minor: M(120_000), currency: "ILS" as const }],
    };
    const without = feesEstimatedOn(ledger(base), a, "2026-03-31");
    const withFees = feesEstimatedOn(ledger({
      ...base,
      transactions: [tx({ type: "fee", date: "2026-02-01", amount_minor: -M(500), fee_kind: "management_balance" })],
    }), a, "2026-03-31");
    expect(withFees).toBe(without);
  });

  it("recording a fee shifts the gap into fees without changing value", () => {
    const a = acct();
    const base = {
      accounts: [a],
      transactions: [tx({ type: "deposit", date: "2026-01-01", amount_minor: M(100_000) })],
      valuations: [{ account_id: 1, date: "2026-06-30", balance_minor: M(110_000), currency: "ILS" as const }],
    };
    const before = summarizeAccount(ledger(base), a, "2026-06-30", "ILS");
    const after = summarizeAccount(ledger({
      ...base,
      transactions: [...base.transactions,
        tx({ type: "fee", date: "2026-06-01", amount_minor: -M(700), fee_kind: "management_balance" })],
    }), a, "2026-06-30", "ILS");

    expect(after.value_minor).toBe(before.value_minor);
    expect(after.net_earnings_minor).toBe(before.net_earnings_minor);
    expect(after.gross_earnings_minor).toBe(before.gross_earnings_minor + M(700));
    expect(after.balance_is_net_of_fees).toBe(true);
    expectIdentity(after);
  });
});

// ── FX ───────────────────────────────────────────────────────────────────────

describe("FX carry-forward", () => {
  const fx = [
    { date: "2026-01-31", base_currency: "USD" as const, quote_currency: "ILS" as const, rate: 3.60 },
    { date: "2026-03-31", base_currency: "USD" as const, quote_currency: "ILS" as const, rate: 3.80 },
  ];

  it("uses the newest rate on-or-before the date", () => {
    expect(resolveFx(fx, "USD", "ILS", "2026-02-15", 45).rate).toBe(3.60);
    expect(resolveFx(fx, "USD", "ILS", "2026-03-31", 45).rate).toBe(3.80);
    expect(resolveFx(fx, "USD", "ILS", "2026-12-31", 45).rate).toBe(3.80);
  });

  it("inverts a rate stored the other way round", () => {
    expect(resolveFx(fx, "ILS", "USD", "2026-02-15", 45).rate).toBeCloseTo(1 / 3.60, 12);
  });

  it("never fabricates: no rate → missing_fx and an unconverted figure", () => {
    const r = resolveFx(fx, "USD", "ILS", "2025-12-01", 45);
    expect(r.missing).toBe(true);
    expect(r.rate).toBe(1);
  });

  it("flags a rate carried forward for too long as stale", () => {
    expect(resolveFx(fx, "USD", "ILS", "2026-04-10", 45).stale).toBe(false);
    expect(resolveFx(fx, "USD", "ILS", "2026-09-01", 45).stale).toBe(true);
  });

  it("converts every figure in the summary and surfaces the flag", () => {
    const a = acct({ currency: "USD", valuation_mode: "balance" });
    const l = ledger({
      accounts: [a], fx,
      transactions: [tx({ type: "deposit", date: "2026-01-15", amount_minor: M(1_000), currency: "USD" })],
      valuations: [{ account_id: 1, date: "2026-02-15", balance_minor: M(1_100), currency: "USD" }],
    });
    const s = summarizeAccount(l, a, "2026-02-15", "ILS");
    expect(s.fx_rate_used).toBe(3.60);
    expect(s.value_display_minor).toBe(M(3_960));       // 1,100 × 3.6
    expect(s.net_principal_display_minor).toBe(M(3_600));
    expect(s.flags).not.toContain("missing_fx");

    const noFx = summarizeAccount(ledger({ ...l, fx: [] }), a, "2026-02-15", "ILS");
    expect(noFx.flags).toContain("missing_fx");
    expect(noFx.value_display_minor).toBe(M(1_100));    // passed through, flagged
  });
});

// ── RSU ──────────────────────────────────────────────────────────────────────

describe("RSU units and principal", () => {
  const grant = {
    id: 1, account_id: 1, symbol: "ACME", grant_date: "2025-04-01", total_units: 400,
    grant_price_minor: M(50), currency: "USD" as const, cliff_months: 12,
    vest_duration_months: 48, vest_frequency: "quarterly" as const,
  };
  const a = acct({ valuation_mode: "market", currency: "USD", category: "rsu" });
  const holdings = [{ id: 10, account_id: 1, symbol: "ACME", display_name: null,
                      asset_class: "stock" as const as string, currency: "USD" as const }];

  const base = {
    accounts: [a], holdings, grants: [grant],
    prices: [{ holding_id: 10, date: "2026-05-01", price_minor: M(70), currency: "USD" as const }],
    vests: [
      { id: 1, grant_id: 1, vest_date: "2026-04-01", units: 100, price_at_vest_minor: M(60),
        units_sold_to_cover_tax: 35, status: "vested" as const },
      { id: 2, grant_id: 1, vest_date: "2026-07-01", units: 100, price_at_vest_minor: null,
        units_sold_to_cover_tax: 0, status: "scheduled" as const },
    ],
  };

  it("vested units net of tax roll into the holding; unvested never do", () => {
    const l = ledger(base);
    expect(unitsHeldOn(l, 10, "2026-05-01")).toBe(65);   // 100 − 35
    expect(unvestedUnitsOn(l, "2026-05-01")).toBe(100);  // the July tranche
    expect(unitsHeldOn(l, 10, "2026-03-31")).toBe(0);    // before the cliff
  });

  it("default 'zero_cost': vested shares add value but no principal", () => {
    const l = ledger(base);
    const s = summarizeAccount(l, a, "2026-05-01", "USD");
    expect(s.value_minor).toBe(M(4_550));      // 65 × $70
    expect(s.net_principal_minor).toBe(0);
    expect(s.net_earnings_minor).toBe(M(4_550));
    expect(s.unvested_units).toBe(100);
    expectIdentity(s);
  });

  it("'vest_price' basis: principal is the taxed value at vest", () => {
    const l = ledger(base);
    const s = summarizeAccount(l, a, "2026-05-01", "USD",
      { ...DEFAULT_OPTIONS, rsuPrincipalBasis: "vest_price" });
    expect(s.net_principal_minor).toBe(M(3_900));   // 65 × $60
    expect(s.net_earnings_minor).toBe(M(650));      // appreciation to $70
    expectIdentity(s);
  });

  it("unvested units are excluded from portfolio value and principal", () => {
    const p = summarizePortfolio(ledger(base), "2026-05-01", "USD");
    expect(p.value_minor).toBe(M(4_550));   // only the 65 vested-net units
    expect(p.unvested_units).toBe(100);
    expect(p.net_principal_minor).toBe(0);
  });
});

// ── SERIES ───────────────────────────────────────────────────────────────────

describe("time series", () => {
  it("carries the last known balance forward across every point", () => {
    const a = acct();
    const l = ledger({
      accounts: [a],
      transactions: [tx({ type: "deposit", date: "2026-01-01", amount_minor: M(100_000) })],
      valuations: [
        { account_id: 1, date: "2026-01-31", balance_minor: M(100_000), currency: "ILS" },
        { account_id: 1, date: "2026-03-31", balance_minor: M(106_000), currency: "ILS" },
      ],
    });
    const pts = accountSeries(l, a, ["2026-01-31", "2026-02-28", "2026-03-31"], "ILS");
    expect(pts.map(p => p.value_minor)).toEqual([M(100_000), M(100_000), M(106_000)]);
    expect(pts.map(p => p.principal_minor)).toEqual([M(100_000), M(100_000), M(100_000)]);
    expect(pts[2].earnings_minor).toBe(M(6_000));
    for (const p of pts) {
      expect(p.principal_minor + p.earnings_minor).toBe(p.value_minor);
    }
  });
});

// ── PORTFOLIO ROLL-UP ────────────────────────────────────────────────────────

describe("summarizePortfolio excludes accounts it cannot value", () => {
  /** A funded account with no price or balance yet — value unknown, not zero. */
  function unvaluedAccount() {
    return {
      account: acct({ id: 2, name: "Brand new" }),
      transactions: [
        tx({ id: 99, account_id: 2, type: "deposit", date: "2026-02-01", amount_minor: M(50_000) }),
      ],
    };
  }

  it("does not report a freshly funded account as a 100% loss", () => {
    const funded = acct({ id: 1, name: "Pension" });
    const { account: fresh, transactions: freshTx } = unvaluedAccount();

    const l = ledger({
      accounts: [funded, fresh],
      transactions: [
        tx({ account_id: 1, type: "deposit", date: "2026-01-01", amount_minor: M(100_000) }),
        ...freshTx,
      ],
      valuations: [{ account_id: 1, date: "2026-06-30", balance_minor: M(110_000), currency: "ILS" }],
    });

    const p = summarizePortfolio(l, "2026-06-30", "ILS");

    // Only the account that can actually be valued contributes.
    expect(p.value_minor).toBe(M(110_000));
    expect(p.net_principal_minor).toBe(M(100_000));
    expect(p.net_earnings_minor).toBe(M(10_000));

    // …and the one left out is named, not silently dropped.
    expect(p.excluded_accounts).toHaveLength(1);
    expect(p.excluded_accounts[0].name).toBe("Brand new");
    expect(p.excluded_accounts[0].net_principal_minor).toBe(M(50_000));
  });

  it("the excluded account still reports its own figures", () => {
    const { account: fresh, transactions: freshTx } = unvaluedAccount();
    const l = ledger({ accounts: [fresh], transactions: freshTx });

    const p = summarizePortfolio(l, "2026-06-30", "ILS");
    const own = p.accounts.find(a => a.account_id === 2)!;

    // The account screen must still say "you put in 50,000 and I can't value it".
    expect(own.net_principal_minor).toBe(M(50_000));
    expect(own.flags).toContain("no_data");

    // But the portfolio headline stays empty rather than showing −50,000.
    expect(p.value_minor).toBe(0);
    expect(p.net_principal_minor).toBe(0);
    expect(p.net_earnings_minor).toBe(0);
  });

  it("includes the account as soon as it has a balance", () => {
    const { account: fresh, transactions: freshTx } = unvaluedAccount();
    const l = ledger({
      accounts: [fresh],
      transactions: freshTx,
      valuations: [{ account_id: 2, date: "2026-03-31", balance_minor: M(51_000), currency: "ILS" }],
    });

    const p = summarizePortfolio(l, "2026-06-30", "ILS");
    expect(p.excluded_accounts).toHaveLength(0);
    expect(p.value_minor).toBe(M(51_000));
    expect(p.net_principal_minor).toBe(M(50_000));
    expect(p.net_earnings_minor).toBe(M(1_000));
  });
});

// ── PORTFOLIO across currencies ──────────────────────────────────────────────

describe("portfolio", () => {
  it("converts each account then sums, and the identity survives", () => {
    const ils = acct({ id: 1, name: "Pension", currency: "ILS" });
    const usd = acct({ id: 2, name: "Broker", currency: "USD", valuation_mode: "market" });
    const l = ledger({
      accounts: [ils, usd],
      holdings: [{ id: 10, account_id: 2, symbol: "VOO", display_name: null, asset_class: "etf", currency: "USD" }],
      fx: [{ date: "2026-01-01", base_currency: "USD", quote_currency: "ILS", rate: 4 }],
      transactions: [
        tx({ account_id: 1, type: "deposit", date: "2026-01-01", amount_minor: M(100_000) }),
        tx({ account_id: 2, type: "deposit", date: "2026-01-01", amount_minor: M(1_000), currency: "USD" }),
        tx({ account_id: 2, type: "buy", holding_id: 10, date: "2026-01-02", quantity: 2,
             price_minor: M(500), amount_minor: -M(1_000), currency: "USD" }),
      ],
      valuations: [{ account_id: 1, date: "2026-06-30", balance_minor: M(110_000), currency: "ILS" }],
      prices: [{ holding_id: 10, date: "2026-06-30", price_minor: M(600), currency: "USD" }],
    });
    const p = summarizePortfolio(l, "2026-06-30", "ILS");
    // 110,000 ILS + (2 × $600 = $1,200 × 4) = 110,000 + 4,800
    expect(p.value_minor).toBe(M(114_800));
    expect(p.net_principal_minor).toBe(M(104_000));   // 100,000 + 1,000×4
    expect(p.net_earnings_minor).toBe(M(10_800));
    expect(p.net_principal_minor + p.net_earnings_minor).toBe(p.value_minor);
  });

  it("simple return is null rather than Infinity when principal is zero", () => {
    const a = acct({ valuation_mode: "market", currency: "USD", category: "rsu" });
    const l = ledger({
      accounts: [a],
      holdings: [{ id: 10, account_id: 1, symbol: "ACME", display_name: null, asset_class: "stock", currency: "USD" }],
      grants: [{ id: 1, account_id: 1, symbol: "ACME", grant_date: "2025-01-01", total_units: 100,
                 grant_price_minor: null, currency: "USD", cliff_months: 0,
                 vest_duration_months: 12, vest_frequency: "annual" }],
      vests: [{ id: 1, grant_id: 1, vest_date: "2026-01-01", units: 100, price_at_vest_minor: M(10),
                units_sold_to_cover_tax: 0, status: "vested" }],
      prices: [{ holding_id: 10, date: "2026-01-01", price_minor: M(12), currency: "USD" }],
    });
    const s = summarizeAccount(l, a, "2026-06-30", "USD");
    expect(s.net_principal_minor).toBe(0);
    expect(s.simple_return_pct).toBeNull();
    expect(Number.isFinite(s.value_minor)).toBe(true);
  });
});
