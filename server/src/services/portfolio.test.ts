import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computePortfolio, enrichInvestment } from "./portfolio.js";

// ── Test DB helpers ───────────────────────────────────────────────────────────
// Mirrors the subset of the real schema that computePortfolio / getRateSync touch.

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_currency TEXT NOT NULL DEFAULT 'NIS',
      fx_override REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      ticker TEXT, isin TEXT, broker TEXT, etf_kind TEXT,
      liquid_date TEXT, closed_at TEXT, deleted_at TEXT,
      monthly_deposit REAL,
      deposit_currency TEXT NOT NULL DEFAULT 'NIS',
      expected_annual_return REAL,
      monthly_contribution REAL,
      fund_id INTEGER, fund_track TEXT,
      fee_deposit_pct REAL, fee_balance_pct REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      units REAL, price_per_unit REAL,
      total_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      occurred_at TEXT NOT NULL, notes TEXT,
      realized_pl REAL, fx_rate_at_buy REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE fx_cache (
      pair TEXT PRIMARY KEY, rate REAL NOT NULL, fetched_at TEXT NOT NULL
    );
    CREATE TABLE price_cache (
      symbol TEXT NOT NULL, asset_type TEXT NOT NULL, currency TEXT NOT NULL,
      price REAL NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY (symbol, asset_type)
    );
    CREATE TABLE il_fund_cache (
      dataset TEXT NOT NULL, fund_id INTEGER NOT NULL, period INTEGER NOT NULL,
      fund_name TEXT, fund_classification TEXT,
      monthly_yield REAL, avg_annual_mgmt_fee REAL, avg_deposit_fee REAL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (dataset, fund_id, period)
    );
  `);
  db.prepare("INSERT INTO users (username, password_hash) VALUES ('test', 'hash')").run();
  return db;
}

/** Pin the USD→NIS rate so conversions are deterministic. */
function setRate(db: Database.Database, rate: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO fx_cache (pair, rate, fetched_at) VALUES ('USD_NIS', ?, ?)"
  ).run(rate, new Date().toISOString());
}

const THIS_YEAR = new Date().getFullYear();
const MID_YEAR = `${THIS_YEAR}-06-15T00:00:00Z`;

function makeInvestment(db: Database.Database): number {
  const r = db
    .prepare("INSERT INTO investments (user_id, type, name) VALUES (1, 'stock', 'Test')")
    .run();
  return r.lastInsertRowid as number;
}

function sell(db: Database.Database, invId: number, realizedPl: number, currency: string): void {
  db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at, realized_pl)
     VALUES (?, 1, 'SELL', 0, ?, ?, ?)`
  ).run(invId, currency, MID_YEAR, realizedPl);
}

function div(db: Database.Database, invId: number, amount: number, currency: string): void {
  db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
     VALUES (?, 1, 'DIV', ?, ?, ?)`
  ).run(invId, amount, currency, MID_YEAR);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computePortfolio — mixed-currency YTD conversion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    setRate(db, 4); // 1 USD = 4 NIS (clean math)
  });

  it("converts mixed NIS + USD SELL rows to NIS before summing realized_ytd", () => {
    const inv = makeInvestment(db);
    sell(db, inv, 100, "NIS"); // → 100 NIS
    sell(db, inv, 50, "USD");  // → 50 * 4 = 200 NIS

    const p = computePortfolio(db, 1);
    expect(p.realized_ytd_nis).toBe(300);
  });

  it("converts mixed NIS + USD DIV rows to NIS before summing dividends_ytd", () => {
    const inv = makeInvestment(db);
    div(db, inv, 30, "NIS"); // → 30 NIS
    div(db, inv, 10, "USD"); // → 10 * 4 = 40 NIS

    const p = computePortfolio(db, 1);
    expect(p.dividends_ytd_nis).toBe(70);
  });

  it("handles a combined SELL + DIV mixed-currency set", () => {
    const inv = makeInvestment(db);
    sell(db, inv, 200, "NIS"); // 200
    sell(db, inv, 25, "USD");  // 100
    div(db, inv, 40, "NIS");   // 40
    div(db, inv, 15, "USD");   // 60

    const p = computePortfolio(db, 1);
    expect(p.realized_ytd_nis).toBe(300);  // 200 + 100
    expect(p.dividends_ytd_nis).toBe(100); // 40 + 60
  });

  it("would have been wrong if rows were summed without conversion (guard)", () => {
    const inv = makeInvestment(db);
    sell(db, inv, 100, "NIS");
    sell(db, inv, 100, "USD"); // raw sum = 200; converted = 100 + 400 = 500

    const p = computePortfolio(db, 1);
    expect(p.realized_ytd_nis).toBe(500);
    expect(p.realized_ytd_nis).not.toBe(200);
  });
});

describe("computePortfolio — cost-only holding (unpriceable ticker)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); setRate(db, 4); });

  it("shows the invested amount (not 0) for an ETF with no live price", () => {
    // ETF with a ticker that has no price_cache entry (e.g. TA-35), bought by amount only.
    const r = db.prepare(
      "INSERT INTO investments (user_id, type, name, ticker) VALUES (1, 'etf', 'TA-35', 'TA 35')"
    ).run();
    const invId = r.lastInsertRowid as number;
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
       VALUES (?, 1, 'BUY', 5000, 'NIS', '${MID_YEAR}')`
    ).run(invId);

    const p = computePortfolio(db, 1);
    expect(p.total_value_nis).toBe(5000);          // valued at cost, not 0
    expect(p.total_net_deposited_nis).toBe(5000);
    expect(p.unrealized_pl_nis).toBe(0);
    expect(p.investment_count).toBe(1);            // present, not closed/hidden
  });
});

describe("enrichInvestment — unrealized P&L only after position established (BUG 1)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); setRate(db, 1); }); // 1 USD = 1 NIS for clean math

  function makeStock(): { id: number; row: any } {
    const r = db.prepare(
      "INSERT INTO investments (user_id, type, name, ticker) VALUES (1, 'stock', 'NVDA', 'NVDA')"
    ).run();
    const id = r.lastInsertRowid as number;
    return { id, row: db.prepare("SELECT * FROM investments WHERE id = ?").get(id) };
  }
  // BUY 10 @ $100 with an explicit created_at (when the position was established).
  function buy(id: number, createdAt: string): void {
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at, created_at)
       VALUES (?, 1, 'BUY', 10, 100, 1000, 'USD', ?, ?)`
    ).run(id, createdAt, createdAt);
  }
  function cachePrice(price: number, fetchedAt: string): void {
    db.prepare(
      `INSERT OR REPLACE INTO price_cache (symbol, asset_type, currency, price, fetched_at)
       VALUES ('NVDA', 'stock', 'USD', ?, ?)`
    ).run(price, fetchedAt);
  }
  const fx = { rate: 1, source: "cached" as const };

  it("no price cache → unrealized 0, pct null (value falls back to cost)", () => {
    const { id, row } = makeStock();
    buy(id, "2026-06-21T10:00:00Z");

    const e = enrichInvestment(db, row, fx);
    expect(e.current_value_nis).toBe(1000); // cost-basis fallback
    expect(e.unrealized_pl_nis).toBe(0);
    expect(e.unrealized_pct).toBeNull();
  });

  it("price cached BEFORE the BUY → value shows live, but unrealized 0", () => {
    const { id, row } = makeStock();
    buy(id, "2026-06-21T12:00:00Z");
    cachePrice(105, "2026-06-21T08:00:00Z"); // pre-entry

    const e = enrichInvestment(db, row, fx);
    expect(e.current_value_nis).toBe(1050); // 10 × 105 (accurate value)
    expect(e.unrealized_pl_nis).toBe(0);    // but no phantom P&L
    expect(e.unrealized_pct).toBeNull();
  });

  it("price cached AFTER the BUY → unrealized = live − cost", () => {
    const { id, row } = makeStock();
    buy(id, "2026-06-21T08:00:00Z");
    cachePrice(105, "2026-06-21T12:00:00Z"); // post-entry market data

    const e = enrichInvestment(db, row, fx);
    expect(e.current_value_nis).toBe(1050);
    expect(e.unrealized_pl_nis).toBe(50);   // 1050 − 1000
    expect(e.unrealized_pct).toBe(5);
  });
});

describe("P&L gating — precision + portfolio aggregate (regression)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); setRate(db, 1); });

  function addStock(createdAt: string, fetchedAt: string) {
    const id = db.prepare(
      "INSERT INTO investments (user_id, type, name, ticker) VALUES (1,'stock','NVDA','NVDA')"
    ).run().lastInsertRowid as number;
    db.prepare(
      `INSERT INTO transactions (investment_id,user_id,kind,units,price_per_unit,total_amount,currency,occurred_at,created_at)
       VALUES (?,1,'BUY',50,100,5000,'USD',?,?)`
    ).run(id, createdAt, createdAt);
    db.prepare(
      "INSERT INTO price_cache (symbol,asset_type,currency,price,fetched_at) VALUES ('NVDA','stock','USD',105,?)"
    ).run(fetchedAt);
    return id;
  }

  it("same-second add-flow price (ms vs second) is NOT counted as post-entry", () => {
    addStock("2026-06-21T10:58:37Z", "2026-06-21T10:58:37.123Z");
    const p = computePortfolio(db, 1);
    expect(p.unrealized_pl_nis).toBe(0);   // no phantom gain on entry
    expect(p.total_value_nis).toBe(5250);  // value still accurate
  });

  it("portfolio total respects the gate (pre-entry price → aggregate unrealized 0)", () => {
    addStock("2026-06-21T10:58:37Z", "2026-06-21T10:00:00.000Z");
    const p = computePortfolio(db, 1);
    expect(p.unrealized_pl_nis).toBe(0);
  });

  it("genuine post-entry price shows up in the portfolio total", () => {
    addStock("2026-06-21T10:58:37Z", "2026-06-21T11:05:00.000Z");
    const p = computePortfolio(db, 1);
    expect(p.unrealized_pl_nis).toBe(250);
  });
});

describe("enrichInvestment — Israeli fund estimated value (Gemel-Net yields)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); setRate(db, 4); });

  function makeGemel(fundId: number | null): any {
    const r = db.prepare(
      `INSERT INTO investments (user_id, type, name, fund_id, fee_balance_pct, monthly_deposit)
       VALUES (1, 'gemel', 'קופת גמל הפניקס', ?, 1.2, 1000)`
    ).run(fundId);
    return db.prepare("SELECT * FROM investments WHERE id = ?").get(r.lastInsertRowid);
  }

  function cacheYield(fundId: number, period: number, y: number): void {
    db.prepare(
      `INSERT OR REPLACE INTO il_fund_cache (dataset, fund_id, period, monthly_yield, fetched_at)
       VALUES ('gemel', ?, ?, ?, ?)`
    ).run(fundId, period, y, new Date().toISOString());
  }

  const fx = { rate: 4, source: "cached" as const };

  it("grows the last balance by cached yields + deposits − fees, flags estimate", () => {
    // Balance snapshot 2 whole months ago; yields published for both months.
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    const row = makeGemel(964);
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
       VALUES (?, 1, 'UPDATE', 100000, 'NIS', ?)`
    ).run(row.id, d.toISOString());

    const p = (m: number) => {
      const t = new Date(); t.setMonth(t.getMonth() - m);
      return t.getFullYear() * 100 + t.getMonth() + 1;
    };
    cacheYield(964, p(1), 1.0);
    cacheYield(964, p(0), 0.5);

    const e = enrichInvestment(db, row, fx);
    expect(e.value_estimated).toBe(true);
    expect(e.last_reported_balance_nis).toBe(100_000);
    const feeM = 1 - 0.012 / 12;
    const expected = ((100_000 * 1.01 * feeM + 1000) * 1.005 * feeM) + 1000;
    expect(e.current_value_nis).toBeCloseTo(expected, 4);
    // P/L stays sane: principal = opening 100k + 2 implied monthly deposits.
    expect(e.net_deposited_nis).toBe(102_000);
  });

  it("no fund_id → plain manual behaviour, no estimate flag", () => {
    const row = makeGemel(null);
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
       VALUES (?, 1, 'UPDATE', 100000, 'NIS', '2026-01-01T00:00:00Z')`
    ).run(row.id);

    const e = enrichInvestment(db, row, fx);
    expect(e.value_estimated).toBe(false);
    expect(e.last_reported_balance_nis).toBeNull();
    expect(e.current_value_nis).toBe(100_000);
  });
});

describe("computePortfolio — manual asset agrees with its card (documented formula)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); setRate(db, 4); });

  it("pension with monthly_deposit: net_deposited = opening + monthly×months; card == portfolio", () => {
    const r = db.prepare(
      "INSERT INTO investments (user_id, type, name, monthly_deposit) VALUES (1, 'pension', 'P', 2000)"
    ).run();
    const invId = r.lastInsertRowid as number;

    // First balance exactly 6 whole months ago, current balance today.
    const first = new Date(); first.setMonth(first.getMonth() - 6);
    db.prepare(
      "INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at) VALUES (?, 1, 'UPDATE', 100000, 'NIS', ?)"
    ).run(invId, first.toISOString());
    db.prepare(
      "INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at) VALUES (?, 1, 'UPDATE', 130000, 'NIS', ?)"
    ).run(invId, new Date().toISOString());

    // Card level (enrichInvestment)
    const row = db.prepare("SELECT * FROM investments WHERE id = ?").get(invId);
    const card = enrichInvestment(db, row as never, { rate: 4, source: "cached" });
    expect(card.net_deposited_nis).toBe(112_000);            // 100k opening + 2000 × 6
    expect(card.unrealized_pl_nis).toBe(18_000);             // 130k − 112k (not +130k)

    // Portfolio level agrees exactly.
    const p = computePortfolio(db, 1);
    expect(p.total_net_deposited_nis).toBe(card.net_deposited_nis); // manual asset included
    expect(p.unrealized_pl_nis).toBeCloseTo(card.unrealized_pl_nis, 9);
    expect(p.total_value_nis).toBe(130_000);
  });
});
