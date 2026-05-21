import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  computePosition,
  recomputeRealized,
  computeManualPosition,
} from "./fifo.js";

// ── Test DB helpers ───────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_currency TEXT NOT NULL DEFAULT 'NIS',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      ticker TEXT,
      isin TEXT,
      broker TEXT,
      etf_kind TEXT,
      liquid_date TEXT,
      closed_at TEXT,
      deleted_at TEXT,
      monthly_deposit REAL,
      deposit_currency TEXT NOT NULL DEFAULT 'NIS',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL,
      units REAL,
      price_per_unit REAL,
      total_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      wallet_id INTEGER,
      occurred_at TEXT NOT NULL,
      notes TEXT,
      realized_pl REAL,
      fx_rate_at_buy REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);

  db.prepare(
    "INSERT INTO users (username, password_hash) VALUES ('test', 'hash')"
  ).run();

  return db;
}

function insertInvestment(
  db: Database.Database,
  type = "stock",
  monthly_deposit: number | null = null
): number {
  const r = db
    .prepare(
      "INSERT INTO investments (user_id, type, name, monthly_deposit) VALUES (1, ?, 'Test', ?)"
    )
    .run(type, monthly_deposit);
  return r.lastInsertRowid as number;
}

function buy(
  db: Database.Database,
  invId: number,
  units: number,
  price: number,
  date: string,
  currency = "USD"
): void {
  db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at)
     VALUES (?, 1, 'BUY', ?, ?, ?, ?, ?)`
  ).run(invId, units, price, units * price, currency, date);
}

function sell(
  db: Database.Database,
  invId: number,
  units: number,
  price: number,
  date: string,
  currency = "USD"
): void {
  db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at)
     VALUES (?, 1, 'SELL', ?, ?, ?, ?, ?)`
  ).run(invId, units, price, units * price, currency, date);
}

function update(
  db: Database.Database,
  invId: number,
  amount: number,
  date: string,
  currency = "NIS"
): void {
  db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
     VALUES (?, 1, 'UPDATE', ?, ?, ?)`
  ).run(invId, amount, currency, date);
}

function deposit(
  db: Database.Database,
  invId: number,
  amount: number,
  date: string,
  currency = "NIS"
): void {
  db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
     VALUES (?, 1, 'DEPOSIT', ?, ?, ?)`
  ).run(invId, amount, currency, date);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("computePosition — FIFO", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns zero position when no transactions", () => {
    const invId = insertInvestment(db);
    const pos = computePosition(db, invId);
    expect(pos.remaining_units).toBe(0);
    expect(pos.cost_basis_remaining).toBe(0);
    expect(pos.realized_pl_total).toBe(0);
    expect(pos.is_closed).toBe(true);
  });

  it("3 BUYs + 1 partial SELL — FIFO realized P/L correct", () => {
    const invId = insertInvestment(db);
    // Buy 10 @ 100, then 5 @ 120, then 8 @ 110
    buy(db, invId, 10, 100, "2024-01-01");
    buy(db, invId, 5,  120, "2024-02-01");
    buy(db, invId, 8,  110, "2024-03-01");

    // Sell 12 @ 130
    // FIFO: use 10 from lot1 + 2 from lot2
    //   lot1: 10 * (130 - 100) = 300
    //   lot2:  2 * (130 - 120) =  20
    //   total realized = 320
    sell(db, invId, 12, 130, "2024-04-01");

    const pos = computePosition(db, invId);

    expect(pos.realized_pl_total).toBeCloseTo(320, 8);
    // Remaining: 3 from lot2 @ 120, 8 from lot3 @ 110
    expect(pos.remaining_units).toBeCloseTo(11, 8);
    expect(pos.cost_basis_remaining).toBeCloseTo(3 * 120 + 8 * 110, 8);
    expect(pos.is_closed).toBe(false);
    expect(pos.lots).toHaveLength(2);
  });

  it("full SELL marks position as closed", () => {
    const invId = insertInvestment(db);
    buy(db, invId, 5, 100, "2024-01-01");
    sell(db, invId, 5, 150, "2024-06-01");

    const pos = computePosition(db, invId);
    expect(pos.remaining_units).toBeCloseTo(0, 8);
    expect(pos.is_closed).toBe(true);
    expect(pos.realized_pl_total).toBeCloseTo(250, 8); // 5 * (150-100)
  });

  it("DIV transactions are ignored by FIFO", () => {
    const invId = insertInvestment(db);
    buy(db, invId, 10, 100, "2024-01-01");
    // Insert a DIV — should not affect lot queue
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
       VALUES (?, 1, 'DIV', 50, 'USD', '2024-03-01')`
    ).run(invId);

    const pos = computePosition(db, invId);
    expect(pos.remaining_units).toBe(10);
    expect(pos.realized_pl_total).toBe(0);
  });
});

describe("recomputeRealized — DB persistence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("persists realized_pl on SELL transactions", () => {
    const invId = insertInvestment(db);
    buy(db, invId, 10, 100, "2024-01-01");
    sell(db, invId, 5, 140, "2024-06-01");

    recomputeRealized(db, invId);

    const tx = db
      .prepare("SELECT realized_pl FROM transactions WHERE kind = 'SELL' AND investment_id = ?")
      .get(invId) as { realized_pl: number };

    expect(tx.realized_pl).toBeCloseTo(5 * (140 - 100), 8); // 200
  });

  it("sets closed_at when fully sold out", () => {
    const invId = insertInvestment(db);
    buy(db, invId, 10, 100, "2024-01-01");
    sell(db, invId, 10, 150, "2024-12-01");

    recomputeRealized(db, invId);

    const inv = db
      .prepare("SELECT closed_at FROM investments WHERE id = ?")
      .get(invId) as { closed_at: string | null };

    expect(inv.closed_at).not.toBeNull();
  });

  it("clears closed_at when SELL is deleted and units remain", () => {
    const invId = insertInvestment(db);
    buy(db, invId, 10, 100, "2024-01-01");
    sell(db, invId, 10, 150, "2024-12-01");

    // First mark as closed
    recomputeRealized(db, invId);
    const inv1 = db.prepare("SELECT closed_at FROM investments WHERE id = ?").get(invId) as any;
    expect(inv1.closed_at).not.toBeNull();

    // Delete the SELL → position reopens
    db.prepare("DELETE FROM transactions WHERE kind = 'SELL' AND investment_id = ?").run(invId);
    recomputeRealized(db, invId);

    const inv2 = db.prepare("SELECT closed_at FROM investments WHERE id = ?").get(invId) as any;
    expect(inv2.closed_at).toBeNull();
  });

  it("multiple SELLs each get correct realized_pl", () => {
    const invId = insertInvestment(db);
    buy(db, invId, 10, 100, "2024-01-01");
    sell(db, invId, 3, 120, "2024-03-01"); // realized = 3 * 20 = 60
    sell(db, invId, 4, 130, "2024-06-01"); // realized = 4 * 30 = 120

    recomputeRealized(db, invId);

    const sells = db
      .prepare(
        "SELECT realized_pl FROM transactions WHERE kind = 'SELL' AND investment_id = ? ORDER BY occurred_at ASC"
      )
      .all(invId) as { realized_pl: number }[];

    expect(sells[0].realized_pl).toBeCloseTo(60, 8);
    expect(sells[1].realized_pl).toBeCloseTo(120, 8);
  });
});

// ── computeManualPosition — new deposit model ─────────────────────────────────

describe("computeManualPosition — pension (monthly_deposit model)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns zero when no UPDATE transactions", () => {
    const invId = insertInvestment(db, "pension");
    const pos = computeManualPosition(db, invId, { type: "pension" });
    expect(pos.current_value).toBe(0);
    expect(pos.net_deposited).toBe(0);
    expect(pos.unrealized_pl).toBe(0);
    expect(pos.update_count).toBe(0);
    expect(pos.last_update_at).toBeNull();
  });

  it("pension with no monthly_deposit → net_deposited=0, unrealized=current_value", () => {
    const invId = insertInvestment(db, "pension", null);
    update(db, invId, 50_000, "2024-01-01");
    update(db, invId, 53_000, "2024-06-01");

    const pos = computeManualPosition(db, invId, { type: "pension", monthly_deposit: null });
    expect(pos.current_value).toBe(53_000);
    expect(pos.net_deposited).toBe(0);
    expect(pos.unrealized_pl).toBe(53_000);
    expect(pos.update_count).toBe(2);
  });

  it("pension: monthly_deposit=2000, first update 12 months ago → expected_deposited=24k, P/L +6k", () => {
    const invId = insertInvestment(db, "pension", 2_000);

    // First UPDATE exactly 12 calendar months ago
    const firstDate = new Date();
    firstDate.setMonth(firstDate.getMonth() - 12);
    const firstIso = firstDate.toISOString().replace(/\.\d{3}Z$/, "Z");

    update(db, invId, 20_000, firstIso);      // initial snapshot
    update(db, invId, 30_000, new Date().toISOString()); // current snapshot

    const pos = computeManualPosition(db, invId, { type: "pension", monthly_deposit: 2_000 });

    expect(pos.current_value).toBe(30_000);
    expect(pos.net_deposited).toBe(24_000);       // 2000 × 12
    expect(pos.unrealized_pl).toBeCloseTo(6_000, 2);
    expect(pos.update_count).toBe(2);
  });

  it("pension: partial month does not count — only whole months", () => {
    // Set first update to exactly N months ago (no day-of-month skew)
    const invId = insertInvestment(db, "pension", 1_000);

    // 6 months ago
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    update(db, invId, 5_000, sixMonthsAgo.toISOString());
    update(db, invId, 7_000, new Date().toISOString());

    const pos = computeManualPosition(db, invId, { type: "pension", monthly_deposit: 1_000 });
    expect(pos.net_deposited).toBe(6_000);  // 1000 × 6
    expect(pos.unrealized_pl).toBe(1_000);  // 7000 - 6000
  });
});

describe("computeManualPosition — education / other (DEPOSIT model)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("no DEPOSIT transactions → net_deposited=0, unrealized=current_value", () => {
    const invId = insertInvestment(db, "education");
    update(db, invId, 100_000, "2024-01-01");

    const pos = computeManualPosition(db, invId, { type: "education" });
    expect(pos.current_value).toBe(100_000);
    expect(pos.net_deposited).toBe(0);
    expect(pos.unrealized_pl).toBe(100_000);
    expect(pos.update_count).toBe(1);
  });

  it("education: two DEPOSITs (1000+1000) + UPDATE 2500 → P/L +500", () => {
    const invId = insertInvestment(db, "education");

    deposit(db, invId, 1_000, "2024-01-01");
    deposit(db, invId, 1_000, "2024-06-01");
    update(db, invId, 2_500, "2024-12-01");

    const pos = computeManualPosition(db, invId, { type: "education" });
    expect(pos.current_value).toBe(2_500);
    expect(pos.net_deposited).toBe(2_000);  // 1000 + 1000
    expect(pos.unrealized_pl).toBe(500);
    expect(pos.update_count).toBe(1);
  });

  it("other: DEPOSIT exceeds current value → negative unrealized P/L", () => {
    const invId = insertInvestment(db, "other");

    deposit(db, invId, 10_000, "2024-01-01");
    update(db, invId, 8_000, "2024-12-01"); // value dropped

    const pos = computeManualPosition(db, invId, { type: "other" });
    expect(pos.current_value).toBe(8_000);
    expect(pos.net_deposited).toBe(10_000);
    expect(pos.unrealized_pl).toBe(-2_000);
  });

  it("current_value reflects the LATEST UPDATE transaction (not earliest)", () => {
    const invId = insertInvestment(db, "education");

    deposit(db, invId, 5_000, "2024-01-01");
    update(db, invId, 5_200, "2024-03-01");
    update(db, invId, 5_800, "2024-09-01"); // newest

    const pos = computeManualPosition(db, invId, { type: "education" });
    expect(pos.current_value).toBe(5_800);
    expect(pos.net_deposited).toBe(5_000);
    expect(pos.unrealized_pl).toBe(800);
    expect(pos.update_count).toBe(2);
  });
});
