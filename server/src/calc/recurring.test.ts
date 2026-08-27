import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../db/migrate.js";
import { dueDates, generateDue, previewUpcoming, type RuleRow } from "./recurring.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  d.prepare(`INSERT INTO accounts (id,name,category,valuation_mode,currency,funding_mode)
             VALUES (1,'Pension','pension','balance','ILS','salary')`).run();
  return d;
}

function rule(d: Database.Database, over: Record<string, unknown> = {}): number {
  const r = {
    account_id: 1, label: "Employee", frequency: "monthly", day_of_month: 9,
    amount_minor: 420_000, currency: "ILS", contribution_part: "employee",
    start_date: "2026-01-01", end_date: null, auto_generate: 1, ...over,
  };
  return d.prepare(
    `INSERT INTO recurring_rules (account_id,label,frequency,day_of_month,amount_minor,
                                  currency,contribution_part,start_date,end_date,auto_generate)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(r.account_id, r.label, r.frequency, r.day_of_month, r.amount_minor, r.currency,
        r.contribution_part, r.start_date, r.end_date, r.auto_generate).lastInsertRowid as number;
}

const dates = (d: Database.Database) =>
  (d.prepare("SELECT date FROM transactions ORDER BY date").all() as { date: string }[]).map(r => r.date);

// ── date planning ────────────────────────────────────────────────────────────

describe("dueDates", () => {
  const base: RuleRow = {
    id: 1, account_id: 1, label: null, frequency: "monthly", day_of_month: 9,
    amount_minor: 1000, currency: "ILS", contribution_part: null,
    start_date: "2026-01-01", end_date: null, auto_generate: 1,
    last_generated_date: null, is_active: 1,
  };

  it("one date per month up to the as-of date", () => {
    expect(dueDates(base, "2026-04-15")).toEqual(
      ["2026-01-09", "2026-02-09", "2026-03-09", "2026-04-09"]);
  });

  it("skips everything at or before the watermark", () => {
    expect(dueDates({ ...base, last_generated_date: "2026-02-09" }, "2026-04-15"))
      .toEqual(["2026-03-09", "2026-04-09"]);
  });

  it("clamps day 31 to the length of each month", () => {
    expect(dueDates({ ...base, day_of_month: 31 }, "2026-03-31"))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("respects end_date", () => {
    expect(dueDates({ ...base, end_date: "2026-02-28" }, "2026-06-01"))
      .toEqual(["2026-01-09", "2026-02-09"]);
  });

  it("quarterly steps stay anchored to the start month", () => {
    expect(dueDates({ ...base, frequency: "quarterly" }, "2026-12-31"))
      .toEqual(["2026-01-09", "2026-04-09", "2026-07-09", "2026-10-09"]);
  });

  it("annual fires once a year on the same month", () => {
    expect(dueDates({ ...base, frequency: "annual" }, "2028-06-01"))
      .toEqual(["2026-01-09", "2027-01-09", "2028-01-09"]);
  });

  it("nothing is due before the start date", () => {
    expect(dueDates({ ...base, start_date: "2026-05-01" }, "2026-03-01")).toEqual([]);
  });
});

// ── IDEMPOTENCY — the property that matters most ─────────────────────────────

describe("generateDue idempotency", () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it("posts each month once", () => {
    rule(d);
    const r = generateDue(d, "2026-04-15");
    expect(r.created).toBe(4);
    expect(dates(d)).toEqual(["2026-01-09", "2026-02-09", "2026-03-09", "2026-04-09"]);
  });

  it("RUNNING IT TWICE CREATES NOTHING", () => {
    rule(d);
    expect(generateDue(d, "2026-04-15").created).toBe(4);
    expect(generateDue(d, "2026-04-15").created).toBe(0);
    expect(dates(d)).toHaveLength(4);
  });

  it("running it ten times still leaves exactly four rows", () => {
    rule(d);
    for (let i = 0; i < 10; i++) generateDue(d, "2026-04-15");
    expect(dates(d)).toHaveLength(4);
  });

  it("advancing the date posts only the new months", () => {
    rule(d);
    generateDue(d, "2026-02-15");
    expect(dates(d)).toHaveLength(2);
    expect(generateDue(d, "2026-04-15").created).toBe(2);
    expect(dates(d)).toHaveLength(4);
  });

  it("DELETING A GENERATED ROW DOES NOT BRING IT BACK", () => {
    rule(d);
    generateDue(d, "2026-04-15");
    d.prepare("DELETE FROM transactions WHERE date = '2026-02-09'").run();
    expect(dates(d)).toHaveLength(3);

    generateDue(d, "2026-04-15");                      // same day
    generateDue(d, "2026-05-20");                      // and later
    expect(dates(d)).not.toContain("2026-02-09");      // stays deleted
    expect(dates(d)).toHaveLength(4);                  // only May was added
  });

  it("editing a generated row leaves the edit intact on the next run", () => {
    rule(d);
    generateDue(d, "2026-04-15");
    d.prepare("UPDATE transactions SET amount_minor = 999_99 WHERE date='2026-03-09'").run();
    generateDue(d, "2026-04-15");
    const row = d.prepare("SELECT amount_minor FROM transactions WHERE date='2026-03-09'").get() as any;
    expect(row.amount_minor).toBe(999_99);
  });

  it("the DB itself refuses a duplicate even if the watermark were wrong", () => {
    const id = rule(d);
    generateDue(d, "2026-04-15");
    d.prepare("UPDATE recurring_rules SET last_generated_date = NULL WHERE id = ?").run(id);
    expect(generateDue(d, "2026-04-15").created).toBe(0);   // UNIQUE index holds the line
    expect(dates(d)).toHaveLength(4);
  });

  it("inactive and auto_generate=0 rules post nothing", () => {
    const id = rule(d);
    d.prepare("UPDATE recurring_rules SET is_active = 0 WHERE id = ?").run(id);
    expect(generateDue(d, "2026-04-15").created).toBe(0);
    d.prepare("UPDATE recurring_rules SET is_active = 1, auto_generate = 0 WHERE id = ?").run(id);
    expect(generateDue(d, "2026-04-15").created).toBe(0);
  });

  it("several rules on one account each post their own split", () => {
    rule(d, { label: "Employee", contribution_part: "employee", amount_minor: 252_000 });
    rule(d, { label: "Employer", contribution_part: "employer", amount_minor: 273_000 });
    rule(d, { label: "Severance", contribution_part: "severance", amount_minor: 349_900 });
    const r = generateDue(d, "2026-03-15");
    expect(r.created).toBe(9);                          // 3 rules × 3 months
    const split = d.prepare(
      "SELECT contribution_part, SUM(amount_minor) m FROM transactions GROUP BY contribution_part ORDER BY contribution_part"
    ).all() as any[];
    expect(split.map(s => s.contribution_part)).toEqual(["employee", "employer", "severance"]);
    expect(split[0].m).toBe(252_000 * 3);
  });

  it("generated rows are marked source='recurring' and linked to their rule", () => {
    const id = rule(d);
    generateDue(d, "2026-02-15");
    const rows = d.prepare("SELECT source, recurring_rule_id FROM transactions").all() as any[];
    expect(rows.every(r => r.source === "recurring" && r.recurring_rule_id === id)).toBe(true);
  });
});

// ── preview ──────────────────────────────────────────────────────────────────

describe("previewUpcoming", () => {
  it("shows what WILL post next without posting it", () => {
    const d = db();
    rule(d);
    generateDue(d, "2026-04-15");
    const before = dates(d).length;

    const up = previewUpcoming(d, "2026-04-15", 3);
    expect(up.map(u => u.date)).toEqual(["2026-05-09", "2026-06-09", "2026-07-09"]);
    expect(up[0].amount_minor).toBe(420_000);
    expect(up[0].account_name).toBe("Pension");
    expect(dates(d)).toHaveLength(before);   // nothing was written
  });

  it("an ended rule has nothing upcoming", () => {
    const d = db();
    rule(d, { end_date: "2026-03-31" });
    expect(previewUpcoming(d, "2026-04-15", 6)).toEqual([]);
  });
});
