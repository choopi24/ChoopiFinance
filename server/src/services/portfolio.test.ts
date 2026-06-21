import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { computePortfolio } from "./portfolio.js";

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
      wallet_id INTEGER, occurred_at TEXT NOT NULL, notes TEXT,
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
