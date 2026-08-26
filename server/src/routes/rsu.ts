import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { valueAccount, today, type AccountRow, type Currency } from "../services/valuation.js";
import {
  generateVestingSchedule, summarizeVesting, materializeVested, syncVestedEntry,
  type GeneratedEvent, type VestingEventRow, type VestingRule,
} from "../services/rsu.js";
import { date, positive, oneOf, isErr } from "./validate.js";

export const rsuRouter = Router();
rsuRouter.use(requireAuth);

const FREQUENCIES = ["monthly", "quarterly", "annual"] as const;
const UNIT_EPS = 1e-6;

function displayCcy(req: { user?: { display_currency?: string } }): Currency {
  return (req.user?.display_currency === "USD" ? "USD" : "ILS");
}

interface DbGrant {
  id: number; account_id: number; user_id: number;
  grant_date: string; total_units: number; grant_price: number | null; notes: string | null;
}

function loadGrant(db: ReturnType<typeof getDb>, id: number, userId: number): DbGrant | undefined {
  return db.prepare("SELECT * FROM rsu_grants WHERE id = ? AND user_id = ?")
    .get(id, userId) as DbGrant | undefined;
}

function grantPayload(db: ReturnType<typeof getDb>, grant: DbGrant, ccy: Currency) {
  const events = db.prepare(
    "SELECT * FROM rsu_vesting_events WHERE grant_id = ? ORDER BY vest_on ASC, id ASC"
  ).all(grant.id) as VestingEventRow[];
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?")
    .get(grant.account_id) as AccountRow;
  return {
    ...grant,
    account: { id: account.id, name: account.name, symbol: account.symbol, currency: account.currency },
    events,
    ...summarizeVesting(events),
    valuation: valueAccount(db, account, ccy, today()),
  };
}

// GET /api/rsu
rsuRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const ccy = displayCcy(req);
    const grants = db.prepare(
      `SELECT g.* FROM rsu_grants g JOIN accounts a ON a.id = g.account_id
       WHERE g.user_id = ? AND a.archived_at IS NULL
       ORDER BY g.grant_date DESC, g.id DESC`
    ).all(req.user!.id) as DbGrant[];
    ok(res, grants.map(g => grantPayload(db, g, ccy)));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rsu — a grant plus its schedule (generated from a rule, or listed)
rsuRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as Record<string, unknown>;

    const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?")
      .get(Number(b.account_id), req.user!.id) as AccountRow | undefined;
    if (!account) return fail(res, "Account not found", 404);
    if (account.valuation_mode !== "market") {
      return fail(res, "RSU grants belong to a market-valued account");
    }

    const grantDate = date(b.grant_date, "grant_date");
    if (isErr(grantDate)) return fail(res, grantDate.error);
    const totalUnits = positive(b.total_units, "total_units");
    if (isErr(totalUnits)) return fail(res, totalUnits.error);

    let grantPrice: number | null = null;
    if (b.grant_price != null && b.grant_price !== "") {
      const p = positive(b.grant_price, "grant_price");
      if (isErr(p)) return fail(res, p.error);
      grantPrice = p.value;
    }

    const hasRule = b.rule != null;
    const hasEvents = b.events != null;
    if (hasRule === hasEvents) {
      return fail(res, "Give either a vesting rule or an explicit list of events, not both");
    }

    let events: GeneratedEvent[];
    let fmvs: (number | null)[];

    if (hasRule) {
      const r = b.rule as Record<string, unknown>;
      const total = Number(r.total_months);
      const cliff = r.cliff_months == null || r.cliff_months === "" ? 0 : Number(r.cliff_months);
      const freq = oneOf(r.frequency, FREQUENCIES, "rule.frequency");
      if (isErr(freq)) return fail(res, freq.error);
      if (!Number.isInteger(total) || total < 1 || total > 240) {
        return fail(res, "rule.total_months must be a whole number from 1 to 240");
      }
      if (!Number.isInteger(cliff) || cliff < 0 || cliff > total) {
        return fail(res, "rule.cliff_months must be between 0 and total_months");
      }
      const rule: VestingRule = { cliff_months: cliff, total_months: total, frequency: freq.value };
      events = generateVestingSchedule(grantDate.value, totalUnits.value, rule);
      fmvs = events.map(() => null);
    } else {
      const raw = b.events;
      if (!Array.isArray(raw) || raw.length === 0) return fail(res, "events must be a non-empty array");
      events = [];
      fmvs = [];
      for (let i = 0; i < raw.length; i++) {
        const e = raw[i] as Record<string, unknown>;
        const d = date(e.vest_on, `events[${i}].vest_on`);
        if (isErr(d)) return fail(res, d.error);
        const u = positive(e.units, `events[${i}].units`);
        if (isErr(u)) return fail(res, u.error);
        let fmv: number | null = null;
        if (e.fmv_at_vest != null && e.fmv_at_vest !== "") {
          const f = positive(e.fmv_at_vest, `events[${i}].fmv_at_vest`);
          if (isErr(f)) return fail(res, f.error);
          fmv = f.value;
        }
        events.push({ vest_on: d.value, units: u.value });
        fmvs.push(fmv);
      }
      const sum = events.reduce((s, e) => s + e.units, 0);
      if (Math.abs(sum - totalUnits.value) > UNIT_EPS) {
        return fail(res, `Those events add up to ${sum} units, but the grant is ${totalUnits.value}`);
      }
    }

    let grantId = 0;
    db.transaction(() => {
      grantId = db.prepare(
        `INSERT INTO rsu_grants (account_id, user_id, grant_date, total_units, grant_price, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(account.id, req.user!.id, grantDate.value, totalUnits.value, grantPrice,
            typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null)
        .lastInsertRowid as number;

      const ins = db.prepare(
        "INSERT INTO rsu_vesting_events (grant_id, vest_on, units, fmv_at_vest) VALUES (?, ?, ?, ?)"
      );
      events.forEach((e, i) => ins.run(grantId, e.vest_on, e.units, fmvs[i]));
    })();

    const grant = loadGrant(db, grantId, req.user!.id)!;
    materializeVested(db, grant);
    ok(res, grantPayload(db, grant, displayCcy(req)), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/rsu/events/:eventId — set the FMV, move a date, adjust units
rsuRouter.patch("/events/:eventId", (req, res) => {
  try {
    const db = getDb();
    const event = db.prepare(
      `SELECT e.* FROM rsu_vesting_events e JOIN rsu_grants g ON g.id = e.grant_id
       WHERE e.id = ? AND g.user_id = ?`
    ).get(Number(req.params.eventId), req.user!.id) as VestingEventRow | undefined;
    if (!event) return fail(res, "Vesting event not found", 404);

    const grant = loadGrant(db, event.grant_id, req.user!.id)!;
    const b = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let unitsDelta = 0;

    if ("vest_on" in b) {
      const d = date(b.vest_on, "vest_on");
      if (isErr(d)) return fail(res, d.error);
      sets.push("vest_on = ?"); vals.push(d.value);
    }
    if ("units" in b) {
      const u = positive(b.units, "units");
      if (isErr(u)) return fail(res, u.error);
      unitsDelta = u.value - event.units;
      sets.push("units = ?"); vals.push(u.value);
    }
    if ("fmv_at_vest" in b) {
      if (b.fmv_at_vest == null || b.fmv_at_vest === "") {
        if (event.status === "vested") {
          return fail(res, "This vest is already a holding — it needs an FMV. Enter a value instead of clearing it.");
        }
        sets.push("fmv_at_vest = ?"); vals.push(null);
      } else {
        const f = positive(b.fmv_at_vest, "fmv_at_vest");
        if (isErr(f)) return fail(res, f.error);
        sets.push("fmv_at_vest = ?"); vals.push(f.value);
      }
    }
    if (sets.length === 0) return fail(res, "No valid fields to update");

    vals.push(event.id);
    db.prepare(`UPDATE rsu_vesting_events SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    if (unitsDelta !== 0) {
      db.prepare(
        "UPDATE rsu_grants SET total_units = total_units + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
      ).run(unitsDelta, grant.id);
    }

    const updated = db.prepare("SELECT * FROM rsu_vesting_events WHERE id = ?")
      .get(event.id) as VestingEventRow;
    syncVestedEntry(db, updated);   // already-posted vest follows the edit
    materializeVested(db, grant);   // newly-eligible vest gets posted

    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, displayCcy(req)));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/rsu/events/:eventId
rsuRouter.delete("/events/:eventId", (req, res) => {
  try {
    const db = getDb();
    const event = db.prepare(
      `SELECT e.* FROM rsu_vesting_events e JOIN rsu_grants g ON g.id = e.grant_id
       WHERE e.id = ? AND g.user_id = ?`
    ).get(Number(req.params.eventId), req.user!.id) as VestingEventRow | undefined;
    if (!event) return fail(res, "Vesting event not found", 404);

    const grant = loadGrant(db, event.grant_id, req.user!.id)!;
    db.transaction(() => {
      if (event.entry_id != null) {
        db.prepare("DELETE FROM entries WHERE id = ?").run(event.entry_id);
      }
      db.prepare("DELETE FROM rsu_vesting_events WHERE id = ?").run(event.id);
      db.prepare(
        "UPDATE rsu_grants SET total_units = total_units - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
      ).run(event.units, grant.id);
    })();

    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, displayCcy(req)));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rsu/:id/events — add a vesting event to an existing grant
rsuRouter.post("/:id/events", (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);

    const b = req.body as Record<string, unknown>;
    const d = date(b.vest_on, "vest_on");
    if (isErr(d)) return fail(res, d.error);
    const u = positive(b.units, "units");
    if (isErr(u)) return fail(res, u.error);
    let fmv: number | null = null;
    if (b.fmv_at_vest != null && b.fmv_at_vest !== "") {
      const f = positive(b.fmv_at_vest, "fmv_at_vest");
      if (isErr(f)) return fail(res, f.error);
      fmv = f.value;
    }

    db.transaction(() => {
      db.prepare(
        "INSERT INTO rsu_vesting_events (grant_id, vest_on, units, fmv_at_vest) VALUES (?, ?, ?, ?)"
      ).run(grant.id, d.value, u.value, fmv);
      db.prepare(
        "UPDATE rsu_grants SET total_units = total_units + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
      ).run(u.value, grant.id);
    })();

    materializeVested(db, grant);
    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, displayCcy(req)), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/rsu/:id — drop the grant, its schedule, and any posted vests
rsuRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);

    db.transaction(() => {
      const posted = db.prepare(
        "SELECT entry_id FROM rsu_vesting_events WHERE grant_id = ? AND entry_id IS NOT NULL"
      ).all(grant.id) as { entry_id: number }[];
      for (const p of posted) db.prepare("DELETE FROM entries WHERE id = ?").run(p.entry_id);
      db.prepare("DELETE FROM rsu_grants WHERE id = ?").run(grant.id);
    })();

    ok(res, { id: grant.id });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rsu/:id/refresh — post any vests that have come due and have an FMV
rsuRouter.post("/:id/refresh", (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);
    const result = materializeVested(db, grant);
    ok(res, { ...result, ...grantPayload(db, grant, displayCcy(req)) });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
