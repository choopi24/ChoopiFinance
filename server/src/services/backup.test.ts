import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runBackup, listBackups } from "./backup.js";
import {
  buildExport, importUserData, validateImportPayload, EXPORT_SCHEMA_VERSION,
} from "./importExport.js";

// Real schema, so these tests can never drift from it.
const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../db/schema.sql"), "utf8"
);

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
    for (let i = 0; i < 5; i++) {
      await runBackup(db, { dir: backups, keep: 3, now: new Date(2026, 0, 1, 10, 0, i) });
    }
    const remaining = readdirSync(backups).sort();
    expect(remaining).toHaveLength(3);
    expect(remaining[0]).toContain("100002");
    expect(listBackups(backups)[0]).toContain("100004");
  });
});

// ── JSON export → import round-trip ───────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO users (username, password_hash) VALUES ('t','h')").run();
  return db;
}

/** Seed one of each thing that only exists because it was typed in by hand. */
function seed(db: Database.Database) {
  // Balance-tracked, salary-funded fund with a rule and a real fee
  const pension = db.prepare(
    `INSERT INTO accounts (user_id, name, kind, valuation_mode, funding_mode, currency,
                           fee_deposit_pct, fee_balance_annual_pct)
     VALUES (1, 'Pension', 'pension', 'balance', 'salary', 'ILS', 1.5, 0.6)`
  ).run().lastInsertRowid as number;

  const ruleId = db.prepare(
    `INSERT INTO deposit_rules (account_id, user_id, amount, currency, day_of_month, start_on)
     VALUES (?, 1, 2000, 'ILS', 10, '2026-01-01')`
  ).run(pension).lastInsertRowid as number;

  db.prepare(
    `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, source, rule_id)
     VALUES (?, 1, 'deposit', '2026-01-10', 2000, 'rule', ?)`
  ).run(pension, ruleId);
  db.prepare(
    `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount)
     VALUES (?, 1, 'balance', '2026-01-31', 105000)`
  ).run(pension);
  db.prepare(
    `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, fee_kind, period_start, period_end)
     VALUES (?, 1, 'fee', '2026-03-31', 480, 'balance', '2026-01-01', '2026-03-31')`
  ).run(pension);

  // Market-valued RSU account with a grant, a vest, and its posted entry
  const rsu = db.prepare(
    `INSERT INTO accounts (user_id, name, kind, valuation_mode, funding_mode, currency, symbol)
     VALUES (1, 'ACME RSU', 'rsu', 'market', 'passive', 'USD', 'ACME')`
  ).run().lastInsertRowid as number;

  const vestEntry = db.prepare(
    `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, quantity, price_per_unit, source)
     VALUES (?, 1, 'buy', '2026-02-01', 5000, 100, 50, 'vest')`
  ).run(rsu).lastInsertRowid as number;

  const grant = db.prepare(
    `INSERT INTO rsu_grants (account_id, user_id, grant_date, total_units, grant_price)
     VALUES (?, 1, '2025-01-01', 400, 45)`
  ).run(rsu).lastInsertRowid as number;

  db.prepare(
    `INSERT INTO rsu_vesting_events (grant_id, vest_on, units, fmv_at_vest, status, entry_id)
     VALUES (?, '2026-02-01', 100, 50, 'vested', ?)`
  ).run(grant, vestEntry);
  db.prepare(
    `INSERT INTO rsu_vesting_events (grant_id, vest_on, units, fmv_at_vest, status)
     VALUES (?, '2027-02-01', 300, NULL, 'scheduled')`
  ).run(grant);

  // The hand-entered series
  db.prepare(
    "INSERT INTO price_points (user_id, symbol, price, currency, as_of) VALUES (1,'ACME',62,'USD','2026-06-01')"
  ).run();
  db.prepare(
    "INSERT INTO fx_rates (user_id, base, quote, rate, as_of) VALUES (1,'USD','ILS',3.7,'2026-06-01')"
  ).run();
}

describe("JSON export → import round-trip", () => {
  it("restores every hand-entered record with FKs remapped and no orphans", () => {
    const db = makeDb();
    seed(db);

    const payload = buildExport(db, 1);
    expect(payload.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(validateImportPayload(payload)).toBeNull();

    const counts = importUserData(db, 1, payload); // import wipes first
    expect(counts).toEqual({
      accounts: 2, entries: 4, price_points: 1, fx_rates: 1,
      deposit_rules: 1, rsu_grants: 1, rsu_vesting_events: 2,
    });

    // Content survives…
    const pension = db.prepare("SELECT * FROM accounts WHERE kind='pension'").get() as any;
    expect(pension.fee_balance_annual_pct).toBe(0.6);
    expect(pension.funding_mode).toBe("salary");
    const fee = db.prepare("SELECT * FROM entries WHERE kind='fee'").get() as any;
    expect(fee.amount).toBe(480);
    expect(fee.period_start).toBe("2026-01-01");

    // …and every foreign key points at the NEW ids, not the exported ones.
    const rule = db.prepare("SELECT * FROM deposit_rules").get() as any;
    expect(rule.account_id).toBe(pension.id);
    const ruleEntry = db.prepare("SELECT * FROM entries WHERE source='rule'").get() as any;
    expect(ruleEntry.rule_id).toBe(rule.id);

    const rsuAcct = db.prepare("SELECT * FROM accounts WHERE kind='rsu'").get() as any;
    const grant = db.prepare("SELECT * FROM rsu_grants").get() as any;
    expect(grant.account_id).toBe(rsuAcct.id);
    const vested = db.prepare("SELECT * FROM rsu_vesting_events WHERE status='vested'").get() as any;
    const vestEntry = db.prepare("SELECT * FROM entries WHERE source='vest'").get() as any;
    expect(vested.entry_id).toBe(vestEntry.id);

    expect(db.pragma("foreign_key_check")).toEqual([]);

    // Re-export matches.
    const again = buildExport(db, 1);
    expect(again.accounts).toHaveLength(2);
    expect(again.price_points[0].price).toBe(62);
    expect(again.fx_rates[0].rate).toBe(3.7);
  });

  it("rejects a payload from a different schema version", () => {
    const db = makeDb();
    seed(db);
    const p = { ...buildExport(db, 1), schema_version: 2 };
    expect(validateImportPayload(p)).toContain("schema_version 2");
    expect(validateImportPayload(null)).toContain("JSON export payload");
    expect(validateImportPayload({ schema_version: 3, accounts: "no", entries: [], price_points: [], fx_rates: [] }))
      .toContain("accounts must be an array");
  });

  it("a failing import rolls back atomically — nothing is lost", () => {
    const db = makeDb();
    seed(db);
    const payload = buildExport(db, 1);
    (payload.entries[0] as any).account_id = 999_999; // dangling reference

    expect(() => importUserData(db, 1, payload)).toThrow("unknown account");
    // The wipe happened inside the same transaction, so the originals stand.
    expect((db.prepare("SELECT COUNT(*) n FROM accounts").get() as any).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) n FROM entries").get() as any).n).toBe(4);
  });
});
