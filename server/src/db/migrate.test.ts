import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runMigrations } from "./migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(__dirname, "schema.sql"), "utf8");
const MIGRATION_FILES = readdirSync(join(__dirname, "migrations")).filter(f => f.endsWith(".sql")).sort();

function columns(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map(c => c.name);
}
function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(r => r.name);
}
function migrationCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) n FROM _migrations").get() as { n: number }).n;
}

// ── Fresh install + idempotency ───────────────────────────────────────────────

describe("runMigrations — fresh install", () => {
  it("schema.sql + all migrations produce the expected final schema", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    runMigrations(db);

    // Every migration recorded (ALTERs on a fresh schema count as applied).
    expect(migrationCount(db)).toBe(MIGRATION_FILES.length);

    // investments has the full column set.
    const invCols = columns(db, "investments");
    for (const c of ["fund_id", "fund_track", "fee_deposit_pct", "fee_balance_pct",
                     "monthly_deposit", "expected_annual_return", "deleted_at"]) {
      expect(invCols).toContain(c);
    }
    expect(invCols).not.toContain("wallet_id");

    // The 'rsu' type is allowed; garbage is not.
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('t','h')").run();
    expect(() =>
      db.prepare("INSERT INTO investments (user_id, type, name) VALUES (1, 'rsu', 'G')").run()
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO investments (user_id, type, name) VALUES (1, 'bogus', 'X')").run()
    ).toThrow(/CHECK/);

    // New tables exist; pruned table does not.
    const t = tables(db);
    for (const name of ["rsu_grants", "rsu_vesting_events", "il_fund_cache"]) {
      expect(t).toContain(name);
    }
    expect(t).not.toContain("crypto_wallets");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1); // rebuilds restored it
  });

  it("is idempotent — a second run does nothing and does not throw", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    runMigrations(db);
    const before = migrationCount(db);
    const rows = (db.prepare("SELECT name, run_at FROM _migrations ORDER BY id").all() as object[]);

    expect(() => runMigrations(db)).not.toThrow();
    expect(migrationCount(db)).toBe(before);
    expect(db.prepare("SELECT name, run_at FROM _migrations ORDER BY id").all()).toEqual(rows);
  });
});

// ── Populated upgrade across the table rebuilds (010 + 011) ───────────────────

/** The schema shape as of migration 009: old type CHECK, wallet_id, crypto_wallets. */
function makePre010Db(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, display_currency TEXT NOT NULL DEFAULT 'NIS',
      fx_override REAL, theme TEXT NOT NULL DEFAULT 'light', display_name TEXT,
      stay_signed_in INTEGER NOT NULL DEFAULT 0, show_on_lock_screen INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), last_login_at TEXT
    );
    CREATE TABLE investments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('crypto','stock','etf','pension','education','other')),
      name TEXT NOT NULL, ticker TEXT, isin TEXT, broker TEXT,
      etf_kind TEXT CHECK(etf_kind IN ('accumulating','distributing') OR etf_kind IS NULL),
      liquid_date TEXT, closed_at TEXT, deleted_at TEXT,
      monthly_deposit REAL, deposit_currency TEXT NOT NULL DEFAULT 'NIS',
      expected_annual_return REAL, monthly_contribution REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE crypto_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('BUY','SELL','DIV','UPDATE','DEPOSIT')),
      units REAL, price_per_unit REAL, total_amount REAL NOT NULL,
      currency TEXT NOT NULL CHECK(currency IN ('NIS','USD')),
      wallet_id INTEGER REFERENCES crypto_wallets(id) ON DELETE SET NULL,
      occurred_at TEXT NOT NULL, notes TEXT, realized_pl REAL, fx_rate_at_buy REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total_value_nis REAL NOT NULL, total_value_usd REAL NOT NULL,
      total_net_deposited_nis REAL NOT NULL, total_net_deposited_usd REAL NOT NULL,
      snapshot_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE fx_cache (pair TEXT PRIMARY KEY, rate REAL NOT NULL, fetched_at TEXT NOT NULL);
    CREATE TABLE price_cache (
      symbol TEXT NOT NULL, asset_type TEXT NOT NULL, currency TEXT NOT NULL,
      price REAL NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (symbol, asset_type)
    );
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      run_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  // 001–009 are "already applied" in this shape; only the rebuilds should run.
  const ins = db.prepare("INSERT INTO _migrations (name) VALUES (?)");
  for (const f of MIGRATION_FILES.filter(f => f < "010")) ins.run(f);
  return db;
}

describe("runMigrations — populated upgrade through the 010/011 rebuilds", () => {
  it("all rows survive with values intact and FKs valid", () => {
    const db = makePre010Db();
    db.prepare("INSERT INTO users (username, password_hash) VALUES ('u','h')").run();
    db.prepare(
      "INSERT INTO investments (user_id, type, name, ticker, broker, monthly_deposit) VALUES (1,'stock','NVIDIA','NVDA','IBKR',NULL)"
    ).run();
    db.prepare(
      "INSERT INTO investments (user_id, type, name, monthly_deposit) VALUES (1,'pension','מגדל פנסיה',2000)"
    ).run();
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at, realized_pl)
       VALUES (1, 1, 'BUY', 10, 100, 1000, 'USD', '2025-06-01T00:00:00Z', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
       VALUES (2, 1, 'UPDATE', 50000, 'NIS', '2025-06-01T00:00:00Z')`
    ).run();

    runMigrations(db);

    // Rows and values intact.
    const invs = db.prepare("SELECT * FROM investments ORDER BY id").all() as Record<string, unknown>[];
    expect(invs).toHaveLength(2);
    expect(invs[0]).toMatchObject({ id: 1, type: "stock", name: "NVIDIA", ticker: "NVDA", broker: "IBKR", fund_id: null });
    expect(invs[1]).toMatchObject({ id: 2, type: "pension", name: "מגדל פנסיה", monthly_deposit: 2000 });

    const txs = db.prepare("SELECT * FROM transactions ORDER BY id").all() as Record<string, unknown>[];
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ investment_id: 1, kind: "BUY", units: 10, price_per_unit: 100, total_amount: 1000, currency: "USD" });
    expect(columns(db, "transactions")).not.toContain("wallet_id");

    // Referential integrity holds after both rebuilds.
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(tables(db)).not.toContain("crypto_wallets");
    // And the new type values are usable on the upgraded table.
    db.prepare("INSERT INTO investments (user_id, type, name) VALUES (1, 'gemel', 'G')").run();
    db.prepare("INSERT INTO investments (user_id, type, name) VALUES (1, 'rsu', 'R')").run();
  });
});

// ── Failure semantics (temp migrations dir) ───────────────────────────────────

describe("runMigrations — failure semantics", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a mid-file failure in a BEGIN/COMMIT rebuild rolls back fully and is NOT recorded", () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (v TEXT);");
    writeFileSync(join(dir, "002_broken_rebuild.sql"), `
      BEGIN;
      CREATE TABLE b (v TEXT NOT NULL);
      INSERT INTO b (v) VALUES ('fine');
      INSERT INTO b (v) VALUES (NULL); -- violates NOT NULL mid-transaction
      COMMIT;
    `);

    const db = new Database(":memory:");
    expect(() => runMigrations(db, dir)).toThrow(/NOT NULL/);

    expect(db.inTransaction).toBe(false);                    // rolled back, not dangling
    expect(tables(db)).not.toContain("b");                   // partial work undone
    const applied = (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(r => r.name);
    expect(applied).toEqual(["001_ok.sql"]);                 // failure not marked applied

    // After "fixing" the migration, a retry applies it cleanly.
    writeFileSync(join(dir, "002_broken_rebuild.sql"), `
      BEGIN;
      CREATE TABLE b (v TEXT NOT NULL);
      INSERT INTO b (v) VALUES ('fine');
      COMMIT;
    `);
    expect(() => runMigrations(db, dir)).not.toThrow();
    expect(tables(db)).toContain("b");
  });

  it('"table already exists" surfaces instead of being marked applied', () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "001_make.sql"), "CREATE TABLE c (v TEXT);");
    writeFileSync(join(dir, "002_collide.sql"), "CREATE TABLE c (v TEXT);"); // no IF NOT EXISTS

    const db = new Database(":memory:");
    expect(() => runMigrations(db, dir)).toThrow(/already exists/);
    const applied = (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(r => r.name);
    expect(applied).toEqual(["001_make.sql"]);
  });

  it('"duplicate column name" is still treated as already-applied', () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "001_make.sql"), "CREATE TABLE d (v TEXT, extra TEXT);");
    writeFileSync(join(dir, "002_add_col.sql"), "ALTER TABLE d ADD COLUMN extra TEXT;");

    const db = new Database(":memory:");
    expect(() => runMigrations(db, dir)).not.toThrow();
    const applied = (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(r => r.name);
    expect(applied).toEqual(["001_make.sql", "002_add_col.sql"]);
  });
});
