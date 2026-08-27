import { describe, it, expect, afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { runMigrations, migrationStatus, MIGRATIONS_DIR } from "./migrate.js";

const INIT_SQL = readFileSync(join(MIGRATIONS_DIR, "001_init.sql"), "utf8");

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map(r => r.name).sort();
}
function indexes(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[])
    .map(r => r.name).sort();
}

// ── The real migration applied to a fresh DB ──────────────────────────────────

describe("001_init against a fresh database", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
  });

  it("creates every table and records itself", () => {
    const r = runMigrations(db);
    expect(r.applied).toEqual(["001_init.sql"]);

    for (const t of ["settings", "users", "accounts", "holdings", "prices",
                     "recurring_rules", "transactions", "valuations", "fx_rates",
                     "rsu_grants", "rsu_vests", "schema_migrations"]) {
      expect(tables(db)).toContain(t);
    }
    expect(migrationStatus(db)).toHaveLength(1);
    expect(migrationStatus(db)[0].version).toBe("001_init.sql");
  });

  it("seeds display_currency = ILS", () => {
    runMigrations(db);
    const row = db.prepare("SELECT value FROM settings WHERE key='display_currency'").get() as { value: string };
    expect(row.value).toBe("ILS");
  });

  it("indexes every (account_id, date) and (holding_id, date) lookup path", () => {
    runMigrations(db);
    const idx = indexes(db);
    for (const name of ["idx_transactions_account_date", "idx_transactions_holding_date",
                        "idx_valuations_account_date", "idx_prices_holding_date",
                        "idx_fx_rates_pair_date", "idx_rsu_vests_grant_date"]) {
      expect(idx).toContain(name);
    }
  });

  it("carry-forward lookups seek an index rather than scanning", () => {
    runMigrations(db);
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map(r => r.detail).join(" | ");

    // The shape every price / FX / balance read uses.
    expect(plan(
      "SELECT price_minor FROM prices WHERE holding_id=1 AND date<='2026-01-01' ORDER BY date DESC LIMIT 1"
    )).toMatch(/USING (COVERING )?INDEX/);
    expect(plan(
      "SELECT rate FROM fx_rates WHERE base_currency='USD' AND quote_currency='ILS' AND date<='2026-01-01' ORDER BY date DESC LIMIT 1"
    )).toMatch(/USING (COVERING )?INDEX/);
    expect(plan(
      "SELECT balance_minor FROM valuations WHERE account_id=1 AND date<='2026-01-01' ORDER BY date DESC LIMIT 1"
    )).toMatch(/USING (COVERING )?INDEX/);
    expect(plan(
      "SELECT SUM(amount_minor) FROM transactions WHERE account_id=1 AND date<='2026-01-01'"
    )).toMatch(/USING (COVERING )?INDEX/);
  });

  it("is idempotent — a second run applies nothing", () => {
    runMigrations(db);
    const before = migrationStatus(db);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toBe(1);
    expect(migrationStatus(db)).toEqual(before);
  });
});

// ── Constraints actually bite ────────────────────────────────────────────────

describe("001_init constraints", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      `INSERT INTO accounts (id, name, category, valuation_mode, currency)
       VALUES (1, 'Broker', 'etf', 'market', 'USD'), (2, 'Pension', 'pension', 'balance', 'ILS')`
    ).run();
    db.prepare(
      `INSERT INTO holdings (id, account_id, symbol, asset_class, currency)
       VALUES (1, 1, 'VOO', 'etf', 'USD')`
    ).run();
  });

  const insert = (cols: string, vals: string) =>
    () => db.prepare(`INSERT INTO transactions (${cols}) VALUES (${vals})`).run();

  it("rejects a non-ISO date", () => {
    expect(insert("account_id,date,type,amount_minor,currency",
                  "2,'31/01/2026','deposit',1000,'ILS'")).toThrow(/CHECK/);
    expect(insert("account_id,date,type,amount_minor,currency",
                  "2,'2026-1-5','deposit',1000,'ILS'")).toThrow(/CHECK/);
    expect(insert("account_id,date,type,amount_minor,currency",
                  "2,'2026-01-05','deposit',1000,'ILS'")).not.toThrow();
  });

  it("enforces the sign convention per type", () => {
    // deposit must be positive, fee negative, withdrawal negative.
    expect(insert("account_id,date,type,amount_minor,currency",
                  "2,'2026-01-31','deposit',-1000,'ILS'")).toThrow(/CHECK/);
    expect(insert("account_id,date,type,amount_minor,currency,fee_kind",
                  "2,'2026-01-31','fee',1000,'ILS','management_balance'")).toThrow(/CHECK/);
    expect(insert("account_id,date,type,amount_minor,currency",
                  "2,'2026-01-31','withdrawal',1000,'ILS'")).toThrow(/CHECK/);
  });

  it("a trade must carry holding, quantity and price", () => {
    expect(insert("account_id,date,type,amount_minor,currency",
                  "1,'2026-01-31','buy',-1000,'USD'")).toThrow(/CHECK/);
    // and a non-trade must NOT carry units
    expect(insert("account_id,date,type,amount_minor,currency,quantity",
                  "2,'2026-01-31','deposit',1000,'ILS',5")).toThrow(/CHECK/);
  });

  it("a fee must state its kind, and only fees may have one", () => {
    expect(insert("account_id,date,type,amount_minor,currency",
                  "2,'2026-01-31','fee',-100,'ILS'")).toThrow(/CHECK/);
    expect(insert("account_id,date,type,amount_minor,currency,fee_kind",
                  "2,'2026-01-31','deposit',100,'ILS','trade'")).toThrow(/CHECK/);
  });

  it("contribution splits belong to deposits only", () => {
    expect(insert("account_id,date,type,amount_minor,currency,contribution_part",
                  "2,'2026-01-31','withdrawal',-100,'ILS','employer'")).toThrow(/CHECK/);
    expect(insert("account_id,date,type,amount_minor,currency,contribution_part",
                  "2,'2026-01-31','deposit',100,'ILS','severance'")).not.toThrow();
  });

  it("source and recurring_rule_id must agree", () => {
    expect(insert("account_id,date,type,amount_minor,currency,source",
                  "2,'2026-01-31','deposit',100,'ILS','recurring'")).toThrow(/CHECK/);
  });

  it("one holding per symbol per account; one price per holding per date", () => {
    expect(() => db.prepare(
      "INSERT INTO holdings (account_id,symbol,asset_class,currency) VALUES (1,'VOO','etf','USD')"
    ).run()).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO prices (holding_id,date,price_minor,currency) VALUES (1,'2026-01-31',48000,'USD')").run();
    expect(() => db.prepare(
      "INSERT INTO prices (holding_id,date,price_minor,currency) VALUES (1,'2026-01-31',49000,'USD')"
    ).run()).toThrow(/UNIQUE/);
  });

  it("cascades children when an account is deleted", () => {
    db.prepare("INSERT INTO prices (holding_id,date,price_minor,currency) VALUES (1,'2026-01-31',48000,'USD')").run();
    db.prepare("DELETE FROM accounts WHERE id=1").run();
    expect((db.prepare("SELECT COUNT(*) n FROM holdings").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM prices").get() as { n: number }).n).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("an RSU vest cannot sell more units for tax than it releases", () => {
    db.prepare(
      `INSERT INTO rsu_grants (id,account_id,symbol,grant_date,total_units,currency,
                               cliff_months,vest_duration_months,vest_frequency)
       VALUES (1,1,'ACME','2025-04-01',1600,'USD',12,48,'quarterly')`
    ).run();
    expect(() => db.prepare(
      "INSERT INTO rsu_vests (grant_id,vest_date,units,units_sold_to_cover_tax) VALUES (1,'2026-04-01',100,150)"
    ).run()).toThrow(/CHECK/);
  });
});

// ── Runner behaviour on a temp migrations dir ────────────────────────────────

describe("runner", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rolls a failed migration back and leaves it unrecorded, so a fix re-runs", () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (v TEXT);");
    writeFileSync(join(dir, "002_broken.sql"),
      "CREATE TABLE b (v TEXT NOT NULL);\nINSERT INTO b (v) VALUES (NULL);");

    const db = new Database(":memory:");
    expect(() => runMigrations(db, dir)).toThrow(/002_broken\.sql failed/);
    expect(db.inTransaction).toBe(false);
    expect(tables(db)).not.toContain("b");
    expect(migrationStatus(db).map(m => m.version)).toEqual(["001_ok.sql"]);

    writeFileSync(join(dir, "002_broken.sql"), "CREATE TABLE b (v TEXT NOT NULL);");
    expect(() => runMigrations(db, dir)).not.toThrow();
    expect(tables(db)).toContain("b");
  });

  it("refuses to run when an applied migration has been edited", () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (v TEXT);");
    const db = new Database(":memory:");
    runMigrations(db, dir);

    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE a (v TEXT, extra TEXT);");
    expect(() => runMigrations(db, dir)).toThrow(/changed after it was applied/);
  });

  it("rejects a migration that manages its own transaction", () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "001_tx.sql"), "BEGIN;\nCREATE TABLE a (v TEXT);\nCOMMIT;");
    const db = new Database(":memory:");
    expect(() => runMigrations(db, dir)).toThrow(/BEGIN\/COMMIT/);
  });

  it("rejects a badly named file", () => {
    dir = mkdtempSync(join(tmpdir(), "choopi-mig-"));
    writeFileSync(join(dir, "init.sql"), "CREATE TABLE a (v TEXT);");
    const db = new Database(":memory:");
    expect(() => runMigrations(db, dir)).toThrow(/001_init\.sql/);
  });
});

// ── The three derivations, proven against the real schema ────────────────────

describe("deposits / earnings / fees are derivable", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // One balance account: ₪100,000 opening principal, ₪10,000 added,
    // ₪700 of fees, statement now reads ₪118,000.
    db.prepare(`INSERT INTO accounts (id,name,category,valuation_mode,currency)
                VALUES (1,'Pension','pension','balance','ILS')`).run();
    const t = db.prepare(
      `INSERT INTO transactions (account_id,date,type,amount_minor,currency,fee_kind,contribution_part)
       VALUES (?,?,?,?,'ILS',?,?)`);
    t.run(1, "2025-12-31", "deposit",  10_000_000, null, null);          // opening
    t.run(1, "2026-03-10", "deposit",     600_000, null, "employee");
    t.run(1, "2026-03-10", "deposit",     400_000, null, "employer");
    t.run(1, "2026-06-30", "fee",         -70_000, "management_balance", null);
    db.prepare(`INSERT INTO valuations (account_id,date,balance_minor,currency)
                VALUES (1,'2026-06-30',11_800_000,'ILS')`).run();
  });

  const AS_OF = "2026-06-30";

  it("deposits = signed sum of deposit/withdrawal, splittable by contribution_part", () => {
    const { m } = db.prepare(
      `SELECT SUM(amount_minor) m FROM transactions
       WHERE account_id=1 AND type IN ('deposit','withdrawal') AND date<=?`
    ).get(AS_OF) as { m: number };
    expect(m).toBe(11_000_000); // ₪110,000

    const split = db.prepare(
      `SELECT contribution_part, SUM(amount_minor) m FROM transactions
       WHERE account_id=1 AND type='deposit' GROUP BY contribution_part`
    ).all() as { contribution_part: string | null; m: number }[];
    expect(split.find(s => s.contribution_part === "employee")!.m).toBe(600_000);
    expect(split.find(s => s.contribution_part === "employer")!.m).toBe(400_000);
  });

  it("fees = negated sum of fee rows, attributable by fee_kind", () => {
    const { m } = db.prepare(
      `SELECT -SUM(amount_minor) m FROM transactions
       WHERE account_id=1 AND type='fee' AND date<=?`
    ).get(AS_OF) as { m: number };
    expect(m).toBe(70_000); // ₪700
  });

  it("earnings = value − deposits + fees, and the identity closes exactly", () => {
    const value = (db.prepare(
      `SELECT balance_minor v FROM valuations
       WHERE account_id=1 AND date<=? ORDER BY date DESC LIMIT 1`
    ).get(AS_OF) as { v: number }).v;
    const deposits = 11_000_000;
    const fees = 70_000;
    const earnings = value - deposits + fees;

    expect(value).toBe(11_800_000);
    expect(earnings).toBe(870_000);                       // ₪8,700 gross growth
    // The identity the whole app rests on, in exact integer minor units.
    expect(deposits + earnings - fees).toBe(value);
  });

  it("market value = net units × carried-forward price, plus leftover cash", () => {
    db.prepare(`INSERT INTO accounts (id,name,category,valuation_mode,currency)
                VALUES (2,'Broker','etf','market','USD')`).run();
    db.prepare(`INSERT INTO holdings (id,account_id,symbol,asset_class,currency)
                VALUES (1,2,'VOO','etf','USD')`).run();
    const t = db.prepare(
      `INSERT INTO transactions (account_id,holding_id,date,type,amount_minor,quantity,price_minor,currency)
       VALUES (?,?,?,?,?,?,?,'USD')`);
    t.run(2, null, "2026-01-10", "deposit", 1_000_000, null, null);   // $10,000 in
    t.run(2, 1,    "2026-01-15", "buy",      -960_000, 20, 48_000);   // 20 @ $480
    // Price entered once, in January; June valuation must carry it forward.
    db.prepare(`INSERT INTO prices (holding_id,date,price_minor,currency)
                VALUES (1,'2026-01-31',50_000,'USD')`).run();

    const units = (db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN type='buy' THEN quantity ELSE -quantity END),0) u
       FROM transactions WHERE holding_id=1 AND date<=?`).get(AS_OF) as { u: number }).u;
    const price = (db.prepare(
      `SELECT price_minor p FROM prices WHERE holding_id=1 AND date<=? ORDER BY date DESC LIMIT 1`
    ).get(AS_OF) as { p: number }).p;
    const cash = (db.prepare(
      `SELECT COALESCE(SUM(amount_minor),0) c FROM transactions WHERE account_id=2 AND date<=?`
    ).get(AS_OF) as { c: number }).c;

    expect(units).toBe(20);
    expect(price).toBe(50_000);              // carried forward from January
    expect(cash).toBe(40_000);               // $400 uninvested
    const value = units * price + cash;      // $10,400
    expect(value).toBe(1_040_000);
    // principal is still just the deposit; earnings is the $400 of appreciation
    expect(1_000_000 + (value - 1_000_000) - 0).toBe(value);
  });
});
