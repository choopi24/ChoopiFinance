import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { enrichInvestment, getUsdNisRate } from "../services/portfolio.js";
import { recomputeRealized } from "../services/fifo.js";
import {
  generateVestingSchedule,
  summarizeVesting,
  materializeDueEvents,
  syncEventTransaction,
  type GeneratedEvent,
  type GrantRow,
  type VestingEventRow,
  type VestingRule,
} from "../services/rsu.js";

export const rsuRouter = Router();
rsuRouter.use(requireAuth);

// ── Validation (hand-rolled, matching projectionValidation.ts style) ──────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCIES = new Set(["monthly", "quarterly", "annual"]);
const UNIT_EPS = 1e-6;

function parseDate(raw: unknown, field: string): { value: string } | { error: string } {
  const s = String(raw ?? "").slice(0, 10);
  if (!ISO_DATE.test(s) || isNaN(new Date(s).getTime())) {
    return { error: `${field} must be a valid YYYY-MM-DD date` };
  }
  return { value: s };
}

function parsePositive(raw: unknown, field: string): { value: number } | { error: string } {
  const v = Number(raw);
  if (raw == null || raw === "" || isNaN(v) || v <= 0) {
    return { error: `${field} must be a positive number` };
  }
  return { value: v };
}

function parseRule(raw: Record<string, unknown>): { value: VestingRule } | { error: string } {
  const total = Number(raw.total_months);
  const cliff = raw.cliff_months == null || raw.cliff_months === "" ? 0 : Number(raw.cliff_months);
  const freq = String(raw.frequency ?? "");
  if (isNaN(total) || !Number.isInteger(total) || total < 1 || total > 240) {
    return { error: "rule.total_months must be an integer between 1 and 240" };
  }
  if (isNaN(cliff) || !Number.isInteger(cliff) || cliff < 0 || cliff > total) {
    return { error: "rule.cliff_months must be an integer between 0 and total_months" };
  }
  if (!FREQUENCIES.has(freq)) {
    return { error: "rule.frequency must be monthly, quarterly, or annual" };
  }
  return { value: { cliff_months: cliff, total_months: total, frequency: freq as VestingRule["frequency"] } };
}

function parseEvents(
  raw: unknown,
  totalUnits: number
): { value: GeneratedEvent[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "events must be a non-empty array" };
  }
  const out: GeneratedEvent[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>;
    const d = parseDate(e.vest_date, `events[${i}].vest_date`);
    if ("error" in d) return d;
    const u = parsePositive(e.units, `events[${i}].units`);
    if ("error" in u) return u;
    if (e.fmv_at_vest != null && e.fmv_at_vest !== "") {
      const f = Number(e.fmv_at_vest);
      if (isNaN(f) || f <= 0) return { error: `events[${i}].fmv_at_vest must be a positive number` };
    }
    out.push({ vest_date: d.value, units: u.value });
  }
  const sum = out.reduce((s, e) => s + e.units, 0);
  if (Math.abs(sum - totalUnits) > UNIT_EPS) {
    return { error: `events units sum to ${sum}, but total_units is ${totalUnits} — they must match` };
  }
  return { value: out };
}

// ── Grant loading + payload shaping ───────────────────────────────────────────

interface DbGrant extends GrantRow {
  company_name: string | null;
  grant_date: string;
  total_units: number;
  grant_price: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function loadGrant(db: ReturnType<typeof getDb>, id: number, userId: number): DbGrant | undefined {
  return db.prepare(
    "SELECT * FROM rsu_grants WHERE id = ? AND user_id = ?"
  ).get(id, userId) as DbGrant | undefined;
}

function loadEvents(db: ReturnType<typeof getDb>, grantId: number): VestingEventRow[] {
  return db.prepare(
    "SELECT * FROM rsu_vesting_events WHERE grant_id = ? ORDER BY vest_date ASC, id ASC"
  ).all(grantId) as VestingEventRow[];
}

/** Grant + events + vesting summary + enriched valuation of the linked investment. */
function grantPayload(db: ReturnType<typeof getDb>, grant: DbGrant, userId: number) {
  const events = loadEvents(db, grant.id);
  const summary = summarizeVesting(events);
  const inv = db.prepare("SELECT * FROM investments WHERE id = ?").get(grant.investment_id);
  const fx = getUsdNisRate(db, userId);
  const enriched = inv ? enrichInvestment(db, inv as never, fx) : null;
  return { ...grant, events, ...summary, investment: enriched };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/rsu — all grants with vesting summary + valuation
rsuRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const grants = db.prepare(
      `SELECT g.* FROM rsu_grants g
       JOIN investments i ON i.id = g.investment_id
       WHERE g.user_id = ? AND i.deleted_at IS NULL
       ORDER BY g.grant_date DESC, g.id DESC`
    ).all(req.user!.id) as DbGrant[];
    ok(res, grants.map(g => grantPayload(db, g, req.user!.id)));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rsu — create a grant with an explicit event list OR a vesting rule
rsuRouter.post("/", async (req, res) => {
  try {
    const db = getDb();
    const body = req.body as Record<string, unknown>;

    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    if (!symbol) return fail(res, "symbol is required");
    const grantDate = parseDate(body.grant_date, "grant_date");
    if ("error" in grantDate) return fail(res, grantDate.error);
    if (grantDate.value > new Date().toISOString().slice(0, 10)) {
      return fail(res, "grant_date cannot be in the future");
    }
    const totalUnits = parsePositive(body.total_units, "total_units");
    if ("error" in totalUnits) return fail(res, totalUnits.error);
    const currency = String(body.currency ?? "USD").toUpperCase();
    if (currency !== "USD" && currency !== "NIS") return fail(res, "currency must be USD or NIS");
    let grantPrice: number | null = null;
    if (body.grant_price != null && body.grant_price !== "") {
      const p = parsePositive(body.grant_price, "grant_price");
      if ("error" in p) return fail(res, p.error);
      grantPrice = p.value;
    }
    const companyName = typeof body.company_name === "string" && body.company_name.trim()
      ? body.company_name.trim() : null;
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

    // Vesting input: explicit events XOR a rule
    const hasEvents = body.events != null;
    const hasRule = body.rule != null;
    if (hasEvents === hasRule) {
      return fail(res, "Provide exactly one of: events (explicit list) or rule (schedule generator)");
    }

    let events: GeneratedEvent[];
    let eventFmvs: (number | null)[] = [];
    if (hasRule) {
      const rule = parseRule(body.rule as Record<string, unknown>);
      if ("error" in rule) return fail(res, rule.error);
      events = generateVestingSchedule(grantDate.value, totalUnits.value, rule.value);
      eventFmvs = events.map(() => null);
    } else {
      const parsed = parseEvents(body.events, totalUnits.value);
      if ("error" in parsed) return fail(res, parsed.error);
      events = parsed.value;
      eventFmvs = (body.events as Record<string, unknown>[]).map(e =>
        e.fmv_at_vest != null && e.fmv_at_vest !== "" ? Number(e.fmv_at_vest) : null
      );
    }

    let grantId = 0;
    db.transaction(() => {
      const inv = db.prepare(
        "INSERT INTO investments (user_id, type, name, ticker, broker) VALUES (?, 'rsu', ?, ?, ?)"
      ).run(
        req.user!.id,
        companyName ? `${companyName} RSU` : `${symbol} RSU`,
        symbol,
        typeof body.broker === "string" && body.broker.trim() ? body.broker.trim() : null
      );
      const g = db.prepare(
        `INSERT INTO rsu_grants
           (investment_id, user_id, symbol, company_name, grant_date, total_units, grant_price, currency, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        inv.lastInsertRowid, req.user!.id, symbol, companyName,
        grantDate.value, totalUnits.value, grantPrice, currency, notes
      );
      grantId = g.lastInsertRowid as number;

      const insertEvent = db.prepare(
        "INSERT INTO rsu_vesting_events (grant_id, vest_date, units, fmv_at_vest) VALUES (?, ?, ?, ?)"
      );
      events.forEach((e, i) => insertEvent.run(grantId, e.vest_date, e.units, eventFmvs[i] ?? null));
    })();

    // Materialize anything already due (fetches historical FMVs — best-effort).
    const grant = loadGrant(db, grantId, req.user!.id)!;
    materializeDueEvents(db, grant);

    ok(res, grantPayload(db, grant, req.user!.id), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/rsu/events/:eventId — edit date / units / FMV (syncs the BUY lot if vested)
rsuRouter.patch("/events/:eventId", async (req, res) => {
  try {
    const db = getDb();
    const eventId = Number(req.params.eventId);
    const event = db.prepare(
      `SELECT e.* FROM rsu_vesting_events e
       JOIN rsu_grants g ON g.id = e.grant_id
       WHERE e.id = ? AND g.user_id = ?`
    ).get(eventId, req.user!.id) as VestingEventRow | undefined;
    if (!event) return fail(res, "Vesting event not found", 404);

    const grant = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(event.grant_id) as DbGrant;
    const body = req.body as Record<string, unknown>;
    const updates: string[] = [];
    const values: unknown[] = [];
    let unitsDelta = 0;

    if ("vest_date" in body) {
      const d = parseDate(body.vest_date, "vest_date");
      if ("error" in d) return fail(res, d.error);
      updates.push("vest_date = ?"); values.push(d.value);
    }
    if ("units" in body) {
      const u = parsePositive(body.units, "units");
      if ("error" in u) return fail(res, u.error);
      unitsDelta = u.value - event.units;
      updates.push("units = ?"); values.push(u.value);
    }
    if ("fmv_at_vest" in body) {
      if (body.fmv_at_vest == null || body.fmv_at_vest === "") {
        if (event.status === "vested") return fail(res, "A vested event needs a cost basis — enter a value instead of clearing it");
        updates.push("fmv_at_vest = ?"); values.push(null);
      } else {
        const f = parsePositive(body.fmv_at_vest, "fmv_at_vest");
        if ("error" in f) return fail(res, f.error);
        updates.push("fmv_at_vest = ?"); values.push(f.value);
      }
    }
    if (updates.length === 0) return fail(res, "No valid fields to update");

    values.push(eventId);
    db.prepare(`UPDATE rsu_vesting_events SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    if (unitsDelta !== 0) {
      db.prepare("UPDATE rsu_grants SET total_units = total_units + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
        .run(unitsDelta, grant.id);
    }

    const updated = db.prepare("SELECT * FROM rsu_vesting_events WHERE id = ?").get(eventId) as VestingEventRow;
    syncEventTransaction(db, updated, grant.investment_id);       // vested → update/unvest the BUY
    materializeDueEvents(db, grant);                        // scheduled + now due + has FMV → vest

    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, req.user!.id));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/rsu/events/:eventId — remove an event (deletes its BUY lot if vested)
rsuRouter.delete("/events/:eventId", (req, res) => {
  try {
    const db = getDb();
    const eventId = Number(req.params.eventId);
    const event = db.prepare(
      `SELECT e.* FROM rsu_vesting_events e
       JOIN rsu_grants g ON g.id = e.grant_id
       WHERE e.id = ? AND g.user_id = ?`
    ).get(eventId, req.user!.id) as VestingEventRow | undefined;
    if (!event) return fail(res, "Vesting event not found", 404);

    const grant = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(event.grant_id) as DbGrant;
    db.transaction(() => {
      if (event.transaction_id != null) {
        db.prepare("DELETE FROM transactions WHERE id = ?").run(event.transaction_id);
      }
      db.prepare("DELETE FROM rsu_vesting_events WHERE id = ?").run(eventId);
      db.prepare("UPDATE rsu_grants SET total_units = total_units - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
        .run(event.units, grant.id);
    })();
    recomputeRealized(db, grant.investment_id);

    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, req.user!.id));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/rsu/:id — grant detail
rsuRouter.get("/:id", (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);
    ok(res, grantPayload(db, grant, req.user!.id));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/rsu/:id — grant metadata (total_units is derived from events; not editable here)
rsuRouter.patch("/:id", (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);

    const body = req.body as Record<string, unknown>;
    const updates: string[] = [];
    const values: unknown[] = [];

    if ("company_name" in body) {
      const v = typeof body.company_name === "string" && body.company_name.trim() ? body.company_name.trim() : null;
      updates.push("company_name = ?"); values.push(v);
    }
    if ("notes" in body) {
      const v = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
      updates.push("notes = ?"); values.push(v);
    }
    if ("grant_price" in body) {
      if (body.grant_price == null || body.grant_price === "") {
        updates.push("grant_price = ?"); values.push(null);
      } else {
        const p = parsePositive(body.grant_price, "grant_price");
        if ("error" in p) return fail(res, p.error);
        updates.push("grant_price = ?"); values.push(p.value);
      }
    }
    if (updates.length === 0) return fail(res, "No valid fields to update");

    updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    values.push(grant.id);
    db.prepare(`UPDATE rsu_grants SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    // Keep the linked investment's display name in sync.
    if ("company_name" in body) {
      const updated = loadGrant(db, grant.id, req.user!.id)!;
      db.prepare("UPDATE investments SET name = ? WHERE id = ?").run(
        updated.company_name ? `${updated.company_name} RSU` : `${updated.symbol} RSU`,
        grant.investment_id
      );
    }

    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, req.user!.id));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/rsu/:id — soft-delete the linked investment (same semantics as other assets)
rsuRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);
    db.prepare(
      "UPDATE investments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
    ).run(grant.investment_id);
    ok(res, { id: grant.id });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rsu/:id/refresh — recompute vesting: materialize due events into BUY lots
rsuRouter.post("/:id/refresh", async (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);
    const result = materializeDueEvents(db, grant);
    if (result.vested > 0)    ok(res, { ...result, ...grantPayload(db, grant, req.user!.id) });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rsu/:id/events — add a vesting event
rsuRouter.post("/:id/events", async (req, res) => {
  try {
    const db = getDb();
    const grant = loadGrant(db, Number(req.params.id), req.user!.id);
    if (!grant) return fail(res, "Grant not found", 404);

    const body = req.body as Record<string, unknown>;
    const d = parseDate(body.vest_date, "vest_date");
    if ("error" in d) return fail(res, d.error);
    const u = parsePositive(body.units, "units");
    if ("error" in u) return fail(res, u.error);
    let fmv: number | null = null;
    if (body.fmv_at_vest != null && body.fmv_at_vest !== "") {
      const f = parsePositive(body.fmv_at_vest, "fmv_at_vest");
      if ("error" in f) return fail(res, f.error);
      fmv = f.value;
    }

    db.prepare(
      "INSERT INTO rsu_vesting_events (grant_id, vest_date, units, fmv_at_vest) VALUES (?, ?, ?, ?)"
    ).run(grant.id, d.value, u.value, fmv);
    db.prepare("UPDATE rsu_grants SET total_units = total_units + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
      .run(u.value, grant.id);

    materializeDueEvents(db, grant);
    ok(res, grantPayload(db, loadGrant(db, grant.id, req.user!.id)!, req.user!.id), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

