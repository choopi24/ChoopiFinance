import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  generateVestingSchedule,
  summarizeVesting,
  materializeDueEvents,
  syncEventTransaction,
  type VestingEventRow,
} from "./rsu.js";
import { computePosition } from "./fifo.js";

// ── Schedule generation ───────────────────────────────────────────────────────

describe("generateVestingSchedule", () => {
  it("4y monthly with 1y cliff: cliff event holds 12/48, then monthly, sum exact", () => {
    const ev = generateVestingSchedule("2024-01-15", 4800, {
      cliff_months: 12, total_months: 48, frequency: "monthly",
    });
    expect(ev[0]).toEqual({ vest_date: "2025-01-15", units: 1200 }); // 12/48 at cliff
    expect(ev).toHaveLength(37);                                     // cliff + 36 monthly
    expect(ev.reduce((s, e) => s + e.units, 0)).toBe(4800);
    expect(ev[1]).toEqual({ vest_date: "2025-02-15", units: 100 });
    expect(ev[ev.length - 1].vest_date).toBe("2028-01-15");
  });

  it("quarterly, no cliff: 16 equal events over 4 years", () => {
    const ev = generateVestingSchedule("2024-03-01", 1600, {
      cliff_months: 0, total_months: 48, frequency: "quarterly",
    });
    expect(ev).toHaveLength(16);
    expect(ev.every(e => e.units === 100)).toBe(true);
    expect(ev[0].vest_date).toBe("2024-06-01");
  });

  it("whole-share grant with non-divisible total: remainder lands in the final event", () => {
    const ev = generateVestingSchedule("2024-01-01", 1000, {
      cliff_months: 0, total_months: 36, frequency: "monthly",
    });
    expect(ev.reduce((s, e) => s + e.units, 0)).toBe(1000);
    expect(ev.every(e => Number.isInteger(e.units) && e.units > 0)).toBe(true);
  });

  it("fractional grant keeps precision and exact sum", () => {
    const ev = generateVestingSchedule("2024-01-01", 100.5, {
      cliff_months: 0, total_months: 12, frequency: "quarterly",
    });
    expect(ev.reduce((s, e) => s + e.units, 0)).toBeCloseTo(100.5, 9);
  });

  it("annual frequency with 1y cliff = 4 equal yearly tranches", () => {
    const ev = generateVestingSchedule("2024-06-30", 400, {
      cliff_months: 12, total_months: 48, frequency: "annual",
    });
    expect(ev).toHaveLength(4);
    expect(ev.map(e => e.units)).toEqual([100, 100, 100, 100]);
    expect(ev[0].vest_date).toBe("2025-06-30");
  });

  it("month-end clamping: Jan 31 grant vests on Feb 28/29", () => {
    const ev = generateVestingSchedule("2024-01-31", 120, {
      cliff_months: 0, total_months: 12, frequency: "monthly",
    });
    expect(ev[0].vest_date).toBe("2024-02-29"); // 2024 is a leap year
    expect(ev[1].vest_date).toBe("2024-03-31");
  });

  it("cliff between step boundaries becomes the first event", () => {
    const ev = generateVestingSchedule("2024-01-01", 480, {
      cliff_months: 4, total_months: 48, frequency: "quarterly",
    });
    expect(ev[0].vest_date).toBe("2024-05-01"); // month 4 cliff
    expect(ev[0].units).toBe(40);               // 4/48 of the grant
    expect(ev.reduce((s, e) => s + e.units, 0)).toBe(480);
  });
});

// ── Vested/unvested summary ───────────────────────────────────────────────────

describe("summarizeVesting", () => {
  const ev = (vest_date: string, units: number, status: "scheduled" | "vested") =>
    ({ vest_date, units, status });

  it("splits past + future correctly and reports next vest", () => {
    const s = summarizeVesting([
      ev("2025-01-01", 100, "vested"),
      ev("2025-07-01", 100, "vested"),
      ev("2026-01-01", 100, "scheduled"),   // past-due, not yet materialized
      ev("2026-12-01", 100, "scheduled"),   // future
      ev("2027-06-01", 100, "scheduled"),   // future
    ], "2026-07-04");
    expect(s.vested_units).toBe(300);       // includes the due-but-unmaterialized event
    expect(s.due_units).toBe(100);
    expect(s.unvested_units).toBe(200);
    expect(s.next_vest_event).toEqual({ vest_date: "2026-12-01", units: 100 });
  });

  it("fully vested grant has no next event", () => {
    const s = summarizeVesting([ev("2024-01-01", 50, "vested")], "2026-07-04");
    expect(s.unvested_units).toBe(0);
    expect(s.next_vest_event).toBeNull();
  });
});

// ── Materialization into FIFO lots ────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT);
    CREATE TABLE investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      ticker TEXT, closed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL, units REAL, price_per_unit REAL,
      total_amount REAL NOT NULL, currency TEXT NOT NULL,
      occurred_at TEXT NOT NULL, notes TEXT, realized_pl REAL, fx_rate_at_buy REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE rsu_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL UNIQUE REFERENCES investments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, symbol TEXT NOT NULL, company_name TEXT,
      grant_date TEXT NOT NULL, total_units REAL NOT NULL, grant_price REAL,
      currency TEXT NOT NULL DEFAULT 'USD', notes TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE rsu_vesting_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER NOT NULL REFERENCES rsu_grants(id) ON DELETE CASCADE,
      vest_date TEXT NOT NULL, units REAL NOT NULL, fmv_at_vest REAL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  db.prepare("INSERT INTO users (username) VALUES ('t')").run();
  return db;
}

function seedGrant(db: Database.Database) {
  const inv = db.prepare(
    "INSERT INTO investments (user_id, type, name, ticker) VALUES (1, 'rsu', 'ACME', 'ACME')"
  ).run();
  const g = db.prepare(
    `INSERT INTO rsu_grants (investment_id, user_id, symbol, grant_date, total_units, currency)
     VALUES (?, 1, 'ACME', '2025-01-01', 300, 'USD')`
  ).run(inv.lastInsertRowid);
  return {
    id: g.lastInsertRowid as number,
    investment_id: inv.lastInsertRowid as number,
    user_id: 1, symbol: "ACME", currency: "USD",
  };
}

function addEvent(db: Database.Database, grantId: number, date: string, units: number, fmv: number | null) {
  return db.prepare(
    "INSERT INTO rsu_vesting_events (grant_id, vest_date, units, fmv_at_vest) VALUES (?, ?, ?, ?)"
  ).run(grantId, date, units, fmv).lastInsertRowid as number;
}

describe("materializeDueEvents", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("due events with an entered FMV become BUY lots; future events stay scheduled", () => {
    const grant = seedGrant(db);
    addEvent(db, grant.id, "2025-06-01", 100, 50);   // due, FMV entered
    addEvent(db, grant.id, "2026-06-01", 100, 80);   // due, FMV entered
    addEvent(db, grant.id, "2027-06-01", 100, null); // future

    const r = materializeDueEvents(db, grant, "2026-07-04");
    expect(r).toEqual({ vested: 2, needs_fmv: 0 });

    const pos = computePosition(db, grant.investment_id);
    expect(pos.remaining_units).toBe(200);
    expect(pos.cost_basis_remaining).toBe(100 * 50 + 100 * 80);
    expect(pos.realized_pl_total).toBe(0); // realized stays 0 until a sale

    const rows = db.prepare("SELECT status, transaction_id FROM rsu_vesting_events ORDER BY vest_date").all() as any[];
    expect(rows.map(r2 => r2.status)).toEqual(["vested", "vested", "scheduled"]);
    expect(rows[0].transaction_id).not.toBeNull();
    expect(rows[2].transaction_id).toBeNull();
  });

  it("a due event with no FMV entered stays scheduled and flags needs_fmv", () => {
    const grant = seedGrant(db);
    addEvent(db, grant.id, "2026-01-01", 100, null);

    // Nothing can look the price up — it waits for you to type it.
    const r = materializeDueEvents(db, grant, "2026-07-04");
    expect(r).toEqual({ vested: 0, needs_fmv: 1 });
    expect(computePosition(db, grant.investment_id).remaining_units).toBe(0);
  });

  it("is idempotent — a second run vests nothing new", () => {
    const grant = seedGrant(db);
    addEvent(db, grant.id, "2026-01-01", 100, 42);
    materializeDueEvents(db, grant, "2026-07-04");
    const again = materializeDueEvents(db, grant, "2026-07-04");
    expect(again).toEqual({ vested: 0, needs_fmv: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM transactions").get()).toEqual({ n: 1 });
  });
});

describe("syncEventTransaction", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  function vestedEvent(grant: ReturnType<typeof seedGrant>): VestingEventRow {
    addEvent(db, grant.id, "2026-01-01", 100, 50);
    materializeDueEvents(db, grant, "2026-07-04");
    return db.prepare("SELECT * FROM rsu_vesting_events LIMIT 1").get() as VestingEventRow;
  }

  it("editing units + FMV updates the linked BUY lot", async () => {
    const grant = seedGrant(db);
    const ev = vestedEvent(grant);

    db.prepare("UPDATE rsu_vesting_events SET units = 120, fmv_at_vest = 60 WHERE id = ?").run(ev.id);
    const updated = db.prepare("SELECT * FROM rsu_vesting_events WHERE id = ?").get(ev.id) as VestingEventRow;
    syncEventTransaction(db, updated, grant.investment_id, "2026-07-04");

    const pos = computePosition(db, grant.investment_id);
    expect(pos.remaining_units).toBe(120);
    expect(pos.cost_basis_remaining).toBe(120 * 60);
  });

  it("moving a vested event to a future date un-vests it (BUY deleted)", async () => {
    const grant = seedGrant(db);
    const ev = vestedEvent(grant);

    db.prepare("UPDATE rsu_vesting_events SET vest_date = '2027-01-01' WHERE id = ?").run(ev.id);
    const updated = db.prepare("SELECT * FROM rsu_vesting_events WHERE id = ?").get(ev.id) as VestingEventRow;
    syncEventTransaction(db, updated, grant.investment_id, "2026-07-04");

    expect(db.prepare("SELECT COUNT(*) n FROM transactions").get()).toEqual({ n: 0 });
    const row = db.prepare("SELECT status, transaction_id FROM rsu_vesting_events WHERE id = ?").get(ev.id) as any;
    expect(row.status).toBe("scheduled");
    expect(row.transaction_id).toBeNull();
  });
});
