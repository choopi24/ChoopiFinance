import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { fifoPosition } from "./fifo.js";
import {
  valueAccount, computePortfolio, conversion, priceOnOrBefore,
  type AccountRow, type Currency,
} from "./valuation.js";
import { recomputeAccruals } from "./fees.js";
import { generateDueDeposits } from "./rules.js";

// Build tests against the REAL schema so they can never drift from it.
const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../db/schema.sql"), "utf8"
);

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO users (username, password_hash) VALUES ('t','h')").run();
  return db;
}

function addAccount(db: Database.Database, over: Partial<AccountRow> = {}): AccountRow {
  const a = {
    name: "Acct", kind: "stock", valuation_mode: "market", funding_mode: "manual",
    currency: "ILS", symbol: "SYM", fee_deposit_pct: null, fee_balance_annual_pct: null,
    ...over,
  } as Partial<AccountRow>;
  const id = db.prepare(
    `INSERT INTO accounts (user_id, name, kind, valuation_mode, funding_mode, currency,
                           symbol, fee_deposit_pct, fee_balance_annual_pct)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(a.name, a.kind, a.valuation_mode, a.funding_mode, a.currency,
        a.symbol ?? null, a.fee_deposit_pct ?? null, a.fee_balance_annual_pct ?? null)
   .lastInsertRowid as number;
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow;
}

function entry(db: Database.Database, accountId: number, e: {
  kind: string; on: string; amount?: number; quantity?: number; price?: number;
  fee_kind?: string; is_estimate?: number; period?: [string, string];
}) {
  db.prepare(
    `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, quantity,
                          price_per_unit, fee_kind, is_estimate, period_start, period_end)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(accountId, e.kind, e.on, e.amount ?? null, e.quantity ?? null, e.price ?? null,
        e.fee_kind ?? null, e.is_estimate ?? 0, e.period?.[0] ?? null, e.period?.[1] ?? null);
}

function price(db: Database.Database, symbol: string, p: number, as_of: string, ccy: Currency = "ILS") {
  db.prepare(
    "INSERT OR REPLACE INTO price_points (user_id, symbol, price, currency, as_of) VALUES (1,?,?,?,?)"
  ).run(symbol, p, ccy, as_of);
}

function fx(db: Database.Database, base: Currency, quote: Currency, rate: number, as_of: string) {
  db.prepare(
    "INSERT OR REPLACE INTO fx_rates (user_id, base, quote, rate, as_of) VALUES (1,?,?,?,?)"
  ).run(base, quote, rate, as_of);
}

/** The identity the whole app rests on. */
function expectIdentity(v: { value: number; principal: number; gross_earnings: number; fees: number }) {
  expect(v.principal + v.gross_earnings - v.fees).toBeCloseTo(v.value, 8);
}

// ── Pure FIFO ─────────────────────────────────────────────────────────────────

describe("fifoPosition", () => {
  it("cost basis of held units is the principal still invested", () => {
    const r = fifoPosition([
      { kind: "buy",  quantity: 10, price_per_unit: 100, occurred_on: "2026-01-01" },
      { kind: "sell", quantity: 5,  price_per_unit: 120, occurred_on: "2026-03-01" },
    ]);
    expect(r.quantity).toBe(5);
    expect(r.cost_basis).toBe(500);        // 5 units still at 100
    expect(r.realized_gain).toBe(100);     // 5 × (120 − 100)
    expect(r.proceeds).toBe(600);
  });

  it("consumes oldest lots first across multiple buys", () => {
    const r = fifoPosition([
      { kind: "buy",  quantity: 10, price_per_unit: 100, occurred_on: "2026-01-01" },
      { kind: "buy",  quantity: 10, price_per_unit: 200, occurred_on: "2026-02-01" },
      { kind: "sell", quantity: 15, price_per_unit: 250, occurred_on: "2026-03-01" },
    ]);
    expect(r.quantity).toBe(5);
    expect(r.cost_basis).toBe(1000);                       // 5 left from the 200 lot
    expect(r.realized_gain).toBe(10 * 150 + 5 * 50);       // 1500 + 250
  });

  it("out-of-order input is sorted, and overselling is reported not thrown", () => {
    const r = fifoPosition([
      { kind: "sell", quantity: 5, price_per_unit: 120, occurred_on: "2026-03-01" },
      { kind: "buy",  quantity: 2, price_per_unit: 100, occurred_on: "2026-01-01" },
    ]);
    expect(r.quantity).toBe(0);
    expect(r.oversold_units).toBeCloseTo(3, 9);
  });
});

// ── Dated lookups: carry-forward ──────────────────────────────────────────────

describe("carry-forward lookups", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("price uses the newest entry on-or-before the date, never a later one", () => {
    price(db, "VOO", 100, "2026-01-10");
    price(db, "VOO", 150, "2026-03-10");
    expect(priceOnOrBefore(db, 1, "VOO", "2026-01-09")).toBeNull();
    expect(priceOnOrBefore(db, 1, "VOO", "2026-02-01")!.price).toBe(100); // carried forward
    expect(priceOnOrBefore(db, 1, "VOO", "2026-03-10")!.price).toBe(150); // inclusive
    expect(priceOnOrBefore(db, 1, "VOO", "2027-01-01")!.price).toBe(150);
  });

  it("FX works in both directions and flags a missing rate instead of faking 1.0", () => {
    fx(db, "USD", "ILS", 3.7, "2026-01-01");
    expect(conversion(db, 1, "USD", "ILS", "2026-06-01").rate).toBe(3.7);
    // Inverse is derived from the same row.
    expect(conversion(db, 1, "ILS", "USD", "2026-06-01").rate).toBeCloseTo(1 / 3.7, 12);
    // Same currency is always 1.
    expect(conversion(db, 1, "ILS", "ILS", "2026-06-01")).toEqual({ rate: 1, missing: false });
    // Before any rate exists → flagged.
    expect(conversion(db, 1, "USD", "ILS", "2025-01-01")).toEqual({ rate: 1, missing: true });
  });
});

// ── Market accounts ───────────────────────────────────────────────────────────

describe("valueAccount — market", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("value = qty × manual price; earnings are gross of fees; identity holds", () => {
    const a = addAccount(db, { symbol: "VOO" });
    entry(db, a.id, { kind: "buy", on: "2026-01-01", quantity: 10, price: 100, amount: 1000 });
    price(db, "VOO", 130, "2026-06-01");
    entry(db, a.id, { kind: "fee", on: "2026-06-01", amount: 20, fee_kind: "other" });

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.quantity).toBe(10);
    expect(v.value).toBe(1300);
    expect(v.principal).toBe(1000);         // FIFO cost basis
    expect(v.fees).toBe(20);
    expect(v.gross_earnings).toBe(320);     // 1300 − 1000 + 20
    expectIdentity(v);
  });

  it("no price entered yet → held at cost, flagged, never reported as zero", () => {
    const a = addAccount(db, { symbol: "NOPRICE" });
    entry(db, a.id, { kind: "buy", on: "2026-01-01", quantity: 4, price: 250, amount: 1000 });

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.value).toBe(1000);
    expect(v.principal).toBe(1000);
    expect(v.gross_earnings).toBe(0);
    expect(v.price_missing).toBe(true);
    expectIdentity(v);
  });

  it("a price entered in USD is converted into the account's currency", () => {
    const a = addAccount(db, { symbol: "AAPL", currency: "ILS" });
    entry(db, a.id, { kind: "buy", on: "2026-01-01", quantity: 10, price: 370, amount: 3700 });
    price(db, "AAPL", 120, "2026-06-01", "USD");
    fx(db, "USD", "ILS", 3.5, "2026-06-01");

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.value).toBeCloseTo(10 * 120 * 3.5, 6); // 4200
    expect(v.gross_earnings).toBeCloseTo(500, 6);
    expectIdentity(v);
  });

  it("valuation is historical: asking for an earlier date ignores later events", () => {
    const a = addAccount(db, { symbol: "VOO" });
    entry(db, a.id, { kind: "buy", on: "2026-01-01", quantity: 10, price: 100, amount: 1000 });
    entry(db, a.id, { kind: "buy", on: "2026-05-01", quantity: 10, price: 200, amount: 2000 });
    price(db, "VOO", 100, "2026-01-01");
    price(db, "VOO", 300, "2026-05-01");

    const early = valueAccount(db, a, "ILS", "2026-02-01");
    expect(early.quantity).toBe(10);
    expect(early.value).toBe(1000);

    const late = valueAccount(db, a, "ILS", "2026-06-01");
    expect(late.quantity).toBe(20);
    expect(late.value).toBe(6000);
    expect(late.principal).toBe(3000);
  });
});

// ── Balance accounts ──────────────────────────────────────────────────────────

describe("valueAccount — balance", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  const pension = (db: Database.Database, over: Partial<AccountRow> = {}) =>
    addAccount(db, { kind: "pension", valuation_mode: "balance", symbol: null, ...over });

  it("opening balance is principal, never profit", () => {
    const a = pension(db);
    entry(db, a.id, { kind: "balance", on: "2026-01-01", amount: 100_000 });
    entry(db, a.id, { kind: "balance", on: "2026-06-01", amount: 130_000 });

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.value).toBe(130_000);
    expect(v.principal).toBe(100_000);      // NOT 0 — and earnings are NOT 130k
    expect(v.gross_earnings).toBe(30_000);
    expectIdentity(v);
  });

  it("logged deposit history takes over from the opening-balance heuristic", () => {
    const a = pension(db);
    entry(db, a.id, { kind: "deposit", on: "2025-01-01", amount: 40_000 });
    entry(db, a.id, { kind: "deposit", on: "2025-07-01", amount: 50_000 });
    entry(db, a.id, { kind: "balance", on: "2026-01-01", amount: 100_000 });  // 90k in, 10k growth
    entry(db, a.id, { kind: "deposit", on: "2026-03-01", amount: 5_000 });
    entry(db, a.id, { kind: "balance", on: "2026-06-01", amount: 120_000 });

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.principal).toBe(95_000);       // 90k logged + 5k after
    expect(v.gross_earnings).toBe(25_000);
    expectIdentity(v);
  });

  it("withdrawals reduce principal", () => {
    const a = pension(db);
    entry(db, a.id, { kind: "balance", on: "2026-01-01", amount: 100_000 });
    entry(db, a.id, { kind: "withdrawal", on: "2026-02-01", amount: 20_000 });
    entry(db, a.id, { kind: "balance", on: "2026-06-01", amount: 85_000 });

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.principal).toBe(80_000);
    expect(v.gross_earnings).toBe(5_000);
    expectIdentity(v);
  });

  it("recording a fee moves the gap into fees without changing value", () => {
    const a = pension(db);
    entry(db, a.id, { kind: "balance", on: "2026-01-01", amount: 100_000 });
    entry(db, a.id, { kind: "balance", on: "2026-06-01", amount: 130_000 });

    const before = valueAccount(db, a, "ILS", "2026-06-30");
    entry(db, a.id, { kind: "fee", on: "2026-06-01", amount: 700, fee_kind: "balance" });
    const after = valueAccount(db, a, "ILS", "2026-06-30");

    expect(after.value).toBe(before.value);                     // net worth unchanged
    expect(after.fees).toBe(700);
    expect(after.gross_earnings).toBe(before.gross_earnings + 700); // drag made visible
    expectIdentity(after);
  });

  it("funded but no statement yet → held at cost, earnings 0 (not negative)", () => {
    const a = pension(db);
    entry(db, a.id, { kind: "deposit", on: "2026-01-01", amount: 5_000 });
    entry(db, a.id, { kind: "fee", on: "2026-01-01", amount: 50, fee_kind: "deposit" });

    const v = valueAccount(db, a, "ILS", "2026-06-30");
    expect(v.principal).toBe(5_000);
    expect(v.gross_earnings).toBe(0);
    expect(v.value).toBe(4_950);
    expectIdentity(v);
  });
});

// ── Fee accrual + true-up ─────────────────────────────────────────────────────

describe("recomputeAccruals", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("accrues a deposit fee per deposit and a monthly balance fee", () => {
    const a = addAccount(db, {
      kind: "keren_hishtalmut", valuation_mode: "balance", symbol: null,
      fee_deposit_pct: 1, fee_balance_annual_pct: 0.6,
    });
    entry(db, a.id, { kind: "deposit", on: "2026-01-15", amount: 1_000 });
    entry(db, a.id, { kind: "balance", on: "2026-01-31", amount: 100_000 });

    const r = recomputeAccruals(db, a, "2026-03-31");
    expect(r.deposit_fees).toBe(1);
    expect(r.balance_fees).toBe(3);   // Jan, Feb, Mar

    const v = valueAccount(db, a, "ILS", "2026-03-31");
    // 1% of 1000 = 10, plus 3 × (0.6%/12 × 100 000) = 3 × 50 = 150
    expect(v.fees).toBeCloseTo(160, 6);
    expect(v.fees_estimated).toBeCloseTo(160, 6);
    expectIdentity(v);
  });

  it("is idempotent — running twice does not double-charge", () => {
    const a = addAccount(db, {
      valuation_mode: "balance", kind: "pension", symbol: null, fee_balance_annual_pct: 1.2,
    });
    entry(db, a.id, { kind: "balance", on: "2026-01-31", amount: 120_000 });

    recomputeAccruals(db, a, "2026-03-31");
    const first = valueAccount(db, a, "ILS", "2026-03-31").fees;
    recomputeAccruals(db, a, "2026-03-31");
    const second = valueAccount(db, a, "ILS", "2026-03-31").fees;

    expect(second).toBeCloseTo(first, 9);
    const rows = db.prepare(
      "SELECT COUNT(*) n FROM entries WHERE kind='fee' AND account_id=?"
    ).get(a.id) as { n: number };
    expect(rows.n).toBe(3);
  });

  it("a real statement fee supersedes the estimates for its period", () => {
    const a = addAccount(db, {
      valuation_mode: "balance", kind: "gemel_lehashkaa", symbol: null, fee_balance_annual_pct: 1.2,
    });
    entry(db, a.id, { kind: "balance", on: "2026-01-31", amount: 120_000 });
    recomputeAccruals(db, a, "2026-03-31");
    expect(valueAccount(db, a, "ILS", "2026-03-31").fees).toBeCloseTo(3 * 120, 6);

    // Statement arrives: Q1 fees were actually 500, not the estimated 360.
    entry(db, a.id, {
      kind: "fee", on: "2026-03-31", amount: 500, fee_kind: "balance",
      period: ["2026-01-01", "2026-03-31"],
    });
    recomputeAccruals(db, a, "2026-03-31");

    const v = valueAccount(db, a, "ILS", "2026-03-31");
    expect(v.fees).toBeCloseTo(500, 6);      // estimates gone, real number stands
    expect(v.fees_estimated).toBe(0);
    expectIdentity(v);
  });
});

// ── Recurring deposit rules ───────────────────────────────────────────────────

describe("generateDueDeposits", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  function rule(db: Database.Database, accountId: number, over: Record<string, unknown> = {}) {
    const r = { amount: 2_000, currency: "ILS", day_of_month: 10, start_on: "2026-01-01", end_on: null, ...over };
    db.prepare(
      `INSERT INTO deposit_rules (account_id, user_id, amount, currency, day_of_month, start_on, end_on)
       VALUES (?, 1, ?, ?, ?, ?, ?)`
    ).run(accountId, r.amount, r.currency, r.day_of_month, r.start_on, r.end_on);
  }

  it("posts one deposit per month up to the as-of date", () => {
    const a = addAccount(db, { kind: "pension", valuation_mode: "balance", symbol: null, funding_mode: "salary" });
    rule(db, a.id);

    const r = generateDueDeposits(db, 1, "2026-04-15");
    expect(r.created).toBe(4);  // Jan–Apr
    const dates = (db.prepare(
      "SELECT occurred_on FROM entries WHERE account_id=? ORDER BY occurred_on"
    ).all(a.id) as { occurred_on: string }[]).map(d => d.occurred_on);
    expect(dates).toEqual(["2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10"]);
  });

  it("is idempotent — a second run creates nothing", () => {
    const a = addAccount(db, { valuation_mode: "balance", kind: "pension", symbol: null });
    rule(db, a.id);
    expect(generateDueDeposits(db, 1, "2026-04-15").created).toBe(4);
    expect(generateDueDeposits(db, 1, "2026-04-15").created).toBe(0);
  });

  it("day 31 clamps to the last day of shorter months", () => {
    const a = addAccount(db, { valuation_mode: "balance", kind: "pension", symbol: null });
    rule(db, a.id, { day_of_month: 31, start_on: "2026-01-01" });
    generateDueDeposits(db, 1, "2026-03-31");
    const dates = (db.prepare(
      "SELECT occurred_on FROM entries WHERE account_id=? ORDER BY occurred_on"
    ).all(a.id) as { occurred_on: string }[]).map(d => d.occurred_on);
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("respects end_on and the active flag", () => {
    const a = addAccount(db, { valuation_mode: "balance", kind: "pension", symbol: null });
    rule(db, a.id, { end_on: "2026-02-28" });
    expect(generateDueDeposits(db, 1, "2026-06-01").created).toBe(2);

    db.prepare("UPDATE deposit_rules SET active = 0").run();
    db.prepare("DELETE FROM entries").run();
    expect(generateDueDeposits(db, 1, "2026-06-01").created).toBe(0);
  });

  it("rule deposits feed principal, and fee accrual sees them", () => {
    const a = addAccount(db, {
      kind: "keren_hishtalmut", valuation_mode: "balance", symbol: null,
      funding_mode: "salary", fee_deposit_pct: 2,
    });
    rule(db, a.id, { amount: 1_000 });
    generateDueDeposits(db, 1, "2026-03-15");
    recomputeAccruals(db, db.prepare("SELECT * FROM accounts WHERE id=?").get(a.id) as AccountRow, "2026-03-15");

    const v = valueAccount(db, a, "ILS", "2026-03-15");
    expect(v.principal).toBe(3_000);          // 3 monthly deposits
    expect(v.fees).toBeCloseTo(60, 6);        // 2% of each
    expect(v.value).toBeCloseTo(2_940, 6);    // no statement yet → at cost, net of fees
    expectIdentity(v);
  });
});

// ── Portfolio across currencies ───────────────────────────────────────────────

describe("computePortfolio", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("converts each account into the display currency before summing", () => {
    const ils = addAccount(db, { name: "Pension", kind: "pension", valuation_mode: "balance", symbol: null, currency: "ILS" });
    entry(db, ils.id, { kind: "balance", on: "2026-01-01", amount: 100_000 });
    entry(db, ils.id, { kind: "balance", on: "2026-06-01", amount: 110_000 });

    const usd = addAccount(db, { name: "VOO", kind: "etf", symbol: "VOO", currency: "USD" });
    entry(db, usd.id, { kind: "buy", on: "2026-01-01", quantity: 10, price: 400, amount: 4_000 });
    price(db, "VOO", 500, "2026-06-01", "USD");
    fx(db, "USD", "ILS", 3.7, "2026-06-01");

    const p = computePortfolio(db, 1, "ILS", "2026-06-30");
    // 110 000 ILS + (5 000 USD × 3.7) = 110 000 + 18 500
    expect(p.value).toBeCloseTo(128_500, 6);
    expect(p.principal).toBeCloseTo(100_000 + 4_000 * 3.7, 6);
    expect(p.gross_earnings).toBeCloseTo(10_000 + 1_000 * 3.7, 6);
    // Portfolio identity holds too.
    expect(p.principal + p.gross_earnings - p.fees).toBeCloseTo(p.value, 6);
    expect(p.fx_missing_accounts).toEqual([]);
  });

  it("flags accounts it could not convert instead of understating the total silently", () => {
    const usd = addAccount(db, { name: "Crypto", kind: "crypto", symbol: "BTC", currency: "USD" });
    entry(db, usd.id, { kind: "buy", on: "2026-01-01", quantity: 1, price: 50_000, amount: 50_000 });
    price(db, "BTC", 60_000, "2026-06-01", "USD");
    // No FX rate entered at all.

    const p = computePortfolio(db, 1, "ILS", "2026-06-30");
    expect(p.fx_missing_accounts).toEqual(["Crypto"]);
    expect(p.value).toBe(60_000); // unconverted, but flagged — not silently zero
  });

  it("reports return and fee drag as percentages of principal", () => {
    const a = addAccount(db, { kind: "pension", valuation_mode: "balance", symbol: null });
    entry(db, a.id, { kind: "balance", on: "2026-01-01", amount: 100_000 });
    entry(db, a.id, { kind: "balance", on: "2026-06-01", amount: 108_000 });
    entry(db, a.id, { kind: "fee", on: "2026-06-01", amount: 2_000, fee_kind: "balance" });

    const p = computePortfolio(db, 1, "ILS", "2026-06-30");
    expect(p.gross_earnings).toBeCloseTo(10_000, 6);  // 8k net + 2k fees
    expect(p.return_pct).toBeCloseTo(10, 6);
    expect(p.fee_pct_of_principal).toBeCloseTo(2, 6);
  });
});
