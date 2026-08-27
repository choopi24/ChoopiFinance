import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../db/migrate.js";
import { planVests, generateVestRows, markVested, schedule } from "./rsu.js";
import type { GrantRow } from "./types.js";

function db(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  d.prepare(`INSERT INTO accounts (id,name,category,valuation_mode,currency)
             VALUES (1,'RSU','rsu','market','USD')`).run();
  return d;
}

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  id: 1, account_id: 1, symbol: "ACME", grant_date: "2025-04-01", total_units: 1600,
  grant_price_minor: 5_200, currency: "USD", cliff_months: 12,
  vest_duration_months: 48, vest_frequency: "quarterly", ...over,
});

// ── schedule generation ──────────────────────────────────────────────────────

describe("planVests", () => {
  it("1-year cliff + quarterly over 4 years: cliff releases 25 %, then 12 tranches", () => {
    const v = planVests(grant());
    expect(v).toHaveLength(13);
    expect(v[0]).toEqual({ vest_date: "2026-04-01", units: 400 });   // 12/48 at the cliff
    expect(v[1]).toEqual({ vest_date: "2026-07-01", units: 100 });
    expect(v[12].vest_date).toBe("2029-04-01");                      // month 48
    expect(v.reduce((s, x) => s + x.units, 0)).toBe(1600);           // exact
  });

  it("no cliff, monthly: one tranche per month, summing exactly", () => {
    const v = planVests(grant({ total_units: 1200, cliff_months: 0, vest_duration_months: 12, vest_frequency: "monthly" }));
    expect(v).toHaveLength(12);
    expect(v.every(x => x.units === 100)).toBe(true);
    expect(v[0].vest_date).toBe("2025-05-01");
    expect(v[11].vest_date).toBe("2026-04-01");
  });

  it("annual frequency with a 1-year cliff gives 4 equal tranches", () => {
    const v = planVests(grant({ total_units: 400, vest_frequency: "annual" }));
    expect(v.map(x => x.units)).toEqual([100, 100, 100, 100]);
    expect(v[0].vest_date).toBe("2026-04-01");
  });

  it("a cliff between period boundaries becomes the first tranche", () => {
    const v = planVests(grant({ total_units: 480, cliff_months: 4 }));
    expect(v[0].vest_date).toBe("2025-08-01");   // month 4
    expect(v[0].units).toBe(40);                 // 4/48 of the grant
    expect(v.reduce((s, x) => s + x.units, 0)).toBe(480);
  });

  it("an indivisible grant still sums exactly — the remainder lands on the last tranche", () => {
    const v = planVests(grant({ total_units: 1000, cliff_months: 0, vest_duration_months: 36, vest_frequency: "monthly" }));
    expect(v.reduce((s, x) => s + x.units, 0)).toBe(1000);
    expect(v.every(x => Number.isInteger(x.units) && x.units > 0)).toBe(true);
  });

  it("clamps a month-end grant date (Jan 31 → Feb 28)", () => {
    const v = planVests(grant({ grant_date: "2024-01-31", total_units: 120,
      cliff_months: 0, vest_duration_months: 12, vest_frequency: "monthly" }));
    expect(v[0].vest_date).toBe("2024-02-29");   // 2024 is a leap year
    expect(v[1].vest_date).toBe("2024-03-31");
  });
});

// ── vesting boundaries: the day before, the day of, and the final vest ───────

describe("vesting boundaries", () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
    d.prepare(`INSERT INTO rsu_grants (id,account_id,symbol,grant_date,total_units,currency,
                                       cliff_months,vest_duration_months,vest_frequency)
               VALUES (1,1,'ACME','2025-04-01',1600,'USD',12,48,'quarterly')`).run();
    generateVestRows(d, grant());
  });

  const statusOn = (date: string) => {
    markVested(d, date);
    return d.prepare("SELECT status, COUNT(*) n FROM rsu_vests GROUP BY status ORDER BY status")
      .all() as { status: string; n: number }[];
  };

  it("writes all 13 tranches, all scheduled", () => {
    expect((d.prepare("SELECT COUNT(*) n FROM rsu_vests").get() as any).n).toBe(13);
    expect((d.prepare("SELECT COUNT(*) n FROM rsu_vests WHERE status='scheduled'").get() as any).n).toBe(13);
  });

  it("THE DAY BEFORE the cliff: nothing has vested", () => {
    expect(statusOn("2026-03-31")).toEqual([{ status: "scheduled", n: 13 }]);
  });

  it("THE DAY OF the cliff: exactly the cliff tranche vests", () => {
    expect(statusOn("2026-04-01")).toEqual([
      { status: "scheduled", n: 12 }, { status: "vested", n: 1 },
    ]);
    const v = d.prepare("SELECT units FROM rsu_vests WHERE status='vested'").get() as any;
    expect(v.units).toBe(400);
  });

  it("THE DAY OF the final vest: everything is vested and the units reconcile", () => {
    expect(statusOn("2029-04-01")).toEqual([{ status: "vested", n: 13 }]);
    const total = d.prepare("SELECT SUM(units) u FROM rsu_vests WHERE status='vested'").get() as any;
    expect(total.u).toBe(1600);
  });

  it("THE DAY BEFORE the final vest: all but the last", () => {
    expect(statusOn("2029-03-31")).toEqual([
      { status: "scheduled", n: 1 }, { status: "vested", n: 12 },
    ]);
  });

  it("marking is idempotent and never touches a cancelled tranche", () => {
    d.prepare("UPDATE rsu_vests SET status='cancelled' WHERE vest_date='2029-04-01'").run();
    expect(markVested(d, "2029-04-01")).toBe(12);
    expect(markVested(d, "2029-04-01")).toBe(0);   // second run: nothing
    const cancelled = d.prepare("SELECT COUNT(*) n FROM rsu_vests WHERE status='cancelled'").get() as any;
    expect(cancelled.n).toBe(1);
  });

  it("regenerating a grant's schedule replaces rather than duplicates", () => {
    generateVestRows(d, grant());
    expect((d.prepare("SELECT COUNT(*) n FROM rsu_vests").get() as any).n).toBe(13);
  });

  it("the schedule view exposes net units after tax withholding", () => {
    markVested(d, "2026-04-01");
    d.prepare("UPDATE rsu_vests SET units_sold_to_cover_tax=140, price_at_vest_minor=6_320 WHERE vest_date='2026-04-01'").run();
    const rows = schedule(d);
    expect(rows).toHaveLength(13);
    const cliff = rows.find(r => r.vest_date === "2026-04-01")!;
    expect(cliff.net_units).toBe(260);      // 400 − 140
    expect(cliff.status).toBe("vested");
    expect(rows[1].status).toBe("scheduled");
  });
});
