import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runBackup, listBackups } from "./backup.js";
import {
  buildExport, importUserData, validateImportPayload, EXPORT_SCHEMA_VERSION,
} from "./importExport.js";

// ── runBackup — consistent copy + retention ───────────────────────────────────

describe("runBackup", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "choopi-backup-"));
    db = new Database(join(dir, "live.db"));
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t VALUES ('hello')").run();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a consistent, openable copy while the source is live (WAL)", async () => {
    const r = await runBackup(db, { dir: join(dir, "backups") });
    expect(r.file).toMatch(/^choopi-\d{8}-\d{6}\.db$/);

    const copy = new Database(join(dir, "backups", r.file), { readonly: true });
    expect(copy.prepare("SELECT v FROM t").get()).toEqual({ v: "hello" });
    expect((copy.pragma("integrity_check") as { integrity_check: string }[])[0].integrity_check).toBe("ok");
    copy.close();
  });

  it("prunes to the newest N backups", async () => {
    const backups = join(dir, "backups");
    // Distinct timestamps so filenames don't collide.
    for (let i = 0; i < 5; i++) {
      await runBackup(db, { dir: backups, keep: 3, now: new Date(2026, 0, 1, 10, 0, i) });
    }
    const remaining = readdirSync(backups).sort();
    expect(remaining).toHaveLength(3);
    expect(remaining[0]).toContain("100002"); // two oldest pruned
    expect(listBackups(backups)[0]).toContain("100004"); // newest first
  });
});

// ── JSON export → wipe → import round-trip ────────────────────────────────────

function makeAppDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL,
      display_name TEXT, display_currency TEXT DEFAULT 'NIS', theme TEXT DEFAULT 'light',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE investments (id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      ticker TEXT, isin TEXT, broker TEXT, etf_kind TEXT, liquid_date TEXT,
      closed_at TEXT, deleted_at TEXT, monthly_deposit REAL,
      deposit_currency TEXT NOT NULL DEFAULT 'NIS',
      expected_annual_return REAL, monthly_contribution REAL,
      fund_id INTEGER, fund_track TEXT, fee_deposit_pct REAL, fee_balance_pct REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, kind TEXT NOT NULL, units REAL, price_per_unit REAL,
      total_amount REAL NOT NULL, currency TEXT NOT NULL, occurred_at TEXT NOT NULL,
      notes TEXT, realized_pl REAL, fx_rate_at_buy REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE portfolio_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, total_value_nis REAL NOT NULL, total_value_usd REAL NOT NULL,
      total_net_deposited_nis REAL NOT NULL, total_net_deposited_usd REAL NOT NULL,
      snapshot_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE rsu_grants (id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL UNIQUE REFERENCES investments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL, symbol TEXT NOT NULL, company_name TEXT,
      grant_date TEXT NOT NULL, total_units REAL NOT NULL, grant_price REAL,
      currency TEXT NOT NULL DEFAULT 'USD', notes TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE rsu_vesting_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER NOT NULL REFERENCES rsu_grants(id) ON DELETE CASCADE,
      vest_date TEXT NOT NULL, units REAL NOT NULL, fmv_at_vest REAL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
  `);
  db.prepare("INSERT INTO users (username) VALUES ('t')").run();
  return db;
}

function seed(db: Database.Database) {
  const inv = db.prepare(
    "INSERT INTO investments (user_id, type, name, ticker, broker) VALUES (1,'rsu','ACME RSU','ACME','Work')"
  ).run().lastInsertRowid as number;
  const tx = db.prepare(
    `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at, notes)
     VALUES (?, 1, 'BUY', 100, 50, 5000, 'USD', '2026-01-01T12:00:00Z', 'RSU vest (ACME)')`
  ).run(inv).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO portfolio_snapshots (user_id, total_value_nis, total_value_usd, total_net_deposited_nis, total_net_deposited_usd) VALUES (1, 15000, 5000, 15000, 5000)"
  ).run();
  const grant = db.prepare(
    `INSERT INTO rsu_grants (investment_id, user_id, symbol, grant_date, total_units, currency)
     VALUES (?, 1, 'ACME', '2025-01-01', 300, 'USD')`
  ).run(inv).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO rsu_vesting_events (grant_id, vest_date, units, fmv_at_vest, status, transaction_id)
     VALUES (?, '2026-01-01', 100, 50, 'vested', ?)`
  ).run(grant, tx);
}

describe("JSON export → import round-trip", () => {
  it("export → wipe → import restores identical data with remapped, consistent ids", () => {
    const db = makeAppDb();
    seed(db);

    const payload = buildExport(db, 1);
    expect(payload.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(validateImportPayload(payload)).toBeNull();

    const counts = importUserData(db, 1, payload); // import also wipes first
    expect(counts).toEqual({
      investments: 1, transactions: 1, snapshots: 1, rsu_grants: 1, rsu_vesting_events: 1,
    });

    // Content round-trips…
    const inv = db.prepare("SELECT * FROM investments WHERE user_id = 1").get() as any;
    expect(inv.name).toBe("ACME RSU");
    expect(inv.broker).toBe("Work");
    const tx = db.prepare("SELECT * FROM transactions WHERE user_id = 1").get() as any;
    expect(tx.total_amount).toBe(5000);
    // …and every FK is remapped to the NEW ids, not the exported ones.
    expect(tx.investment_id).toBe(inv.id);
    const grant = db.prepare("SELECT * FROM rsu_grants WHERE user_id = 1").get() as any;
    expect(grant.investment_id).toBe(inv.id);
    const ev = db.prepare("SELECT * FROM rsu_vesting_events").get() as any;
    expect(ev.grant_id).toBe(grant.id);
    expect(ev.transaction_id).toBe(tx.id);

    // Re-export equals first export modulo ids/timestamps.
    const again = buildExport(db, 1);
    expect(again.investments).toHaveLength(1);
    expect(again.transactions[0].total_amount).toBe(5000);
  });

  it("a v1 payload (no RSU arrays) imports cleanly", () => {
    const db = makeAppDb();
    seed(db);
    const v2 = buildExport(db, 1);
    const v1 = { ...v2, schema_version: 1, rsu_grants: undefined, rsu_vesting_events: undefined };

    expect(validateImportPayload(v1)).toBeNull();
    const counts = importUserData(db, 1, v1 as never);
    expect(counts.investments).toBe(1);
    expect(counts.rsu_grants).toBe(0);
  });

  it("rejects unsupported schema versions and malformed payloads", () => {
    expect(validateImportPayload({ schema_version: 99, investments: [], transactions: [], snapshots: [] }))
      .toContain("Unsupported schema_version");
    expect(validateImportPayload({ schema_version: 2, investments: "nope", transactions: [], snapshots: [] }))
      .toContain("investments must be an array");
    expect(validateImportPayload(null)).toContain("JSON export payload");
  });

  it("a failing import rolls back atomically (nothing wiped)", () => {
    const db = makeAppDb();
    seed(db);
    const payload = buildExport(db, 1);
    // Poison one transaction with a dangling investment reference.
    (payload.transactions[0] as any).investment_id = 999_999;

    expect(() => importUserData(db, 1, payload)).toThrow("unknown investment");
    // Original rows still intact — the wipe happened inside the same transaction.
    expect((db.prepare("SELECT COUNT(*) n FROM investments WHERE user_id = 1").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM transactions WHERE user_id = 1").get() as any).n).toBe(1);
  });
});
