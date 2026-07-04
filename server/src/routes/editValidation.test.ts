import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  validateTransactionPatch,
  validateInvestmentPatchValue,
  type TxPatchContext,
} from "./editValidation.js";
import { computePosition, recomputeRealized } from "../services/fifo.js";

// ── validateTransactionPatch — partial-edit semantics ─────────────────────────

describe("validateTransactionPatch", () => {
  const buy: TxPatchContext = { kind: "BUY", units: 10, price_per_unit: 100, total_amount: 1000 };

  it("units-only edit re-derives total_amount from the merged row", () => {
    const r = validateTransactionPatch(buy, { units: 20 });
    expect(r).toEqual({ fields: { units: 20, total_amount: 2000 } });
  });

  it("price-only edit re-derives total_amount", () => {
    const r = validateTransactionPatch(buy, { price_per_unit: 150 });
    expect(r).toEqual({ fields: { price_per_unit: 150, total_amount: 1500 } });
  });

  it("explicit total_amount in the same request wins over derivation", () => {
    const r = validateTransactionPatch(buy, { units: 20, total_amount: 1234 });
    expect(r).toEqual({ fields: { units: 20, total_amount: 1234 } });
  });

  it("non-trade kinds (UPDATE) never derive", () => {
    const upd: TxPatchContext = { kind: "UPDATE", units: null, price_per_unit: null, total_amount: 5000 };
    const r = validateTransactionPatch(upd, { total_amount: 6000 });
    expect(r).toEqual({ fields: { total_amount: 6000 } });
  });

  it("untouched fields never appear in the update set", () => {
    const r = validateTransactionPatch(buy, { notes: "hello" });
    expect(r).toEqual({ fields: { notes: "hello" } });
  });

  it("rejects negative units (would corrupt FIFO into a cost-only lot)", () => {
    expect(validateTransactionPatch(buy, { units: -5 })).toEqual({ error: "units must be a positive number" });
  });

  it("rejects an unparseable date and normalizes a valid one to ISO", () => {
    expect(validateTransactionPatch(buy, { occurred_at: "not-a-date" }))
      .toEqual({ error: "occurred_at must be a valid date" });
    const ok = validateTransactionPatch(buy, { occurred_at: "2026-03-15" });
    expect(ok).toEqual({ fields: { occurred_at: "2026-03-15T00:00:00.000Z" } });
  });

  it("rejects an unsupported currency as 400 (not a SQLite CHECK 500)", () => {
    expect(validateTransactionPatch(buy, { currency: "EUR" })).toEqual({ error: "currency must be NIS or USD" });
  });

  it("empty body → error", () => {
    expect(validateTransactionPatch(buy, {})).toEqual({ error: "No valid fields to update" });
  });
});

// ── validateInvestmentPatchValue ──────────────────────────────────────────────

describe("validateInvestmentPatchValue", () => {
  it("rejects empty name; trims a valid one", () => {
    expect(validateInvestmentPatchValue("name", "  ")).toEqual({ error: "name cannot be empty" });
    expect(validateInvestmentPatchValue("name", " Apple ")).toEqual({ value: "Apple" });
  });

  it("etf_kind: enum-checked, null/empty clears", () => {
    expect(validateInvestmentPatchValue("etf_kind", "garbage"))
      .toEqual({ error: "etf_kind must be accumulating or distributing" });
    expect(validateInvestmentPatchValue("etf_kind", null)).toEqual({ value: null });
    expect(validateInvestmentPatchValue("etf_kind", "accumulating")).toEqual({ value: "accumulating" });
  });

  it("broker: explicit null and empty string both clear", () => {
    expect(validateInvestmentPatchValue("broker", null)).toEqual({ value: null });
    expect(validateInvestmentPatchValue("broker", "  ")).toEqual({ value: null });
    expect(validateInvestmentPatchValue("broker", " IBKR ")).toEqual({ value: "IBKR" });
  });

  it("liquid_date validated; deposit_currency enum-checked", () => {
    expect(validateInvestmentPatchValue("liquid_date", "nope")).toEqual({ error: "liquid_date must be a valid date" });
    expect(validateInvestmentPatchValue("liquid_date", "2030-09-01")).toEqual({ value: "2030-09-01" });
    expect(validateInvestmentPatchValue("deposit_currency", "EUR")).toEqual({ error: "deposit_currency must be NIS or USD" });
  });
});

// ── Repeated edits against a real FIFO position (idempotence, ordering) ──────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      ticker TEXT, closed_at TEXT, deleted_at TEXT
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      kind TEXT NOT NULL, units REAL, price_per_unit REAL,
      total_amount REAL NOT NULL, currency TEXT NOT NULL,
      occurred_at TEXT NOT NULL, notes TEXT, realized_pl REAL, fx_rate_at_buy REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  return db;
}

/** Apply a validated patch the same way the route does. */
function applyPatch(db: Database.Database, txId: number, body: Record<string, unknown>) {
  const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId) as TxPatchContext & { investment_id: number };
  const r = validateTransactionPatch(tx, body);
  if ("error" in r) throw new Error(r.error);
  const keys = Object.keys(r.fields);
  db.prepare(`UPDATE transactions SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map(k => r.fields[k]), txId);
  recomputeRealized(db, tx.investment_id);
}

describe("edit + re-edit against FIFO (route semantics)", () => {
  let db: Database.Database;
  let invId: number;
  let buyId: number;

  beforeEach(() => {
    db = makeDb();
    invId = db.prepare("INSERT INTO investments (user_id, type, name, ticker) VALUES (1,'stock','T','T')")
      .run().lastInsertRowid as number;
    buyId = db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at)
       VALUES (?, 1, 'BUY', 10, 100, 1000, 'USD', '2026-01-10T00:00:00Z')`
    ).run(invId).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at)
       VALUES (?, 1, 'SELL', 5, 120, 600, 'USD', '2026-03-01T00:00:00Z')`
    ).run(invId);
    recomputeRealized(db, invId);
  });

  it("three successive single-field edits: no drift, no lot duplication", () => {
    applyPatch(db, buyId, { units: 20 });
    applyPatch(db, buyId, { price_per_unit: 90 });
    applyPatch(db, buyId, { units: 20 }); // repeat — idempotent

    const pos = computePosition(db, invId);
    expect(pos.lots).toHaveLength(1);                       // still exactly one BUY lot
    expect(pos.remaining_units).toBe(15);                   // 20 − 5 sold
    expect(pos.cost_basis_remaining).toBe(15 * 90);
    expect(pos.realized_pl_total).toBe(5 * (120 - 90));     // SELL recomputed against new cost
    const row = db.prepare("SELECT total_amount FROM transactions WHERE id = ?").get(buyId) as { total_amount: number };
    expect(row.total_amount).toBe(20 * 90);                 // ledger row consistent with the lot
  });

  it("editing occurred_at reorders FIFO: BUY moved after the SELL leaves it unmatched", () => {
    applyPatch(db, buyId, { occurred_at: "2026-04-01" });
    const pos = computePosition(db, invId);
    // SELL now precedes any lot → realizes nothing; the BUY lot is fully intact.
    expect(pos.realized_pl_total).toBe(0);
    expect(pos.remaining_units).toBe(10);
  });
});
