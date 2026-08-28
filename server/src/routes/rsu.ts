/**
 * RSU grants and their vesting schedules.
 *
 * Creating or re-shaping a grant regenerates its tranches from
 * (cliff, duration, frequency). Editing a single tranche — the manually-entered
 * price_at_vest, or units sold to cover withholding — never regenerates, or the
 * numbers you just typed would be wiped.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import {
  getAccount, priceOn, loadLedger, rsu, today,
  type GrantRow, type IsoDate,
} from "../calc/index.js";
import {
  CURRENCIES, FREQUENCIES, VEST_STATUSES,
  absent, badRequest, date, enumOf, intParam, notFound, num,
  optMinorInt, optStr, qDate,
} from "./_validate.js";

export const rsuRouter = Router();
rsuRouter.use(requireAuth);

/** The shape the grant expander needs, whichever way the grant arrived. */
const SHAPE_KEYS = ["grant_date", "total_units", "cliff_months", "vest_duration_months", "vest_frequency"] as const;

/**
 * GET /api/rsu — everything the RSU screen needs in one call: grants with
 * vested/unvested splits, the full tranche list, and the last known price.
 */
rsuRouter.get("/", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  rsu.markVested(db, asOf);

  const ledger = loadLedger(db, { includeInactive: true });
  const grants = db.prepare(`
    SELECT g.*, a.name AS account_name, a.currency AS account_currency
    FROM rsu_grants g JOIN accounts a ON a.id = g.account_id ORDER BY g.grant_date DESC, g.id DESC
  `).all() as (GrantRow & { account_name: string })[];

  const allVests = rsu.schedule(db);

  const enriched = grants.map(g => {
    const vests = allVests.filter(v => v.grant_id === g.id);
    const done = vests.filter(v => v.status === "vested" && v.vest_date <= asOf);
    const upcoming = vests.filter(v => v.status === "scheduled" && v.vest_date > asOf);

    const vestedUnits = done.reduce((s, v) => s + v.units, 0);
    const netUnits = done.reduce((s, v) => s + v.net_units, 0);
    const soldToCover = done.reduce((s, v) => s + v.units_sold_to_cover_tax, 0);

    // Price the vested units off the linked holding if there is one, otherwise
    // off the most recent price_at_vest actually entered.
    const holding = ledger.holdings.find(h => h.account_id === g.account_id && h.symbol === g.symbol);
    const live = holding ? priceOn(ledger, holding.id, asOf) : null;
    const lastVestPrice = [...done].reverse().find(v => v.price_at_vest_minor != null);
    const priceMinor = live?.price_minor ?? lastVestPrice?.price_at_vest_minor ?? null;

    return {
      ...g,
      vested_units: vestedUnits,
      unvested_units: vests.filter(v => v.status === "scheduled").reduce((s, v) => s + v.units, 0),
      units_sold_to_cover_tax: soldToCover,
      net_vested_units: netUnits,
      last_price_minor: priceMinor,
      last_price_date: live?.date ?? null,
      last_price_source: live ? "holding" : lastVestPrice ? "vest" : null,
      vested_value_minor: priceMinor == null ? null : Math.round(netUnits * priceMinor),
      next_vest: upcoming[0] ?? null,
      vests,
    };
  });

  ok(res, { as_of: asOf, grants: enriched });
});

/** GET /api/rsu/schedule — every tranche across every grant, in vest order. */
rsuRouter.get("/schedule", (_req, res) => {
  ok(res, { schedule: rsu.schedule(getDb()) });
});

/** GET /api/rsu/vests?grant_id= — the editable tranche table. */
rsuRouter.get("/vests", (req, res) => {
  const db = getDb();
  const all = rsu.schedule(db);
  const grantId = req.query.grant_id ? intParam(req.query.grant_id, "grant_id") : null;
  ok(res, { vests: grantId ? all.filter(v => v.grant_id === grantId) : all });
});

function buildGrant(b: Record<string, unknown>, accountCurrency: string) {
  const grant = {
    symbol: (absent(b, "symbol") ? "" : String(b.symbol)).trim().toUpperCase(),
    grant_date: date(b, "grant_date"),
    total_units: num(b, "total_units", { min: Number.MIN_VALUE }),
    grant_price_minor: optMinorInt(b, "grant_price_minor", { min: 0 }),
    currency: absent(b, "currency") ? accountCurrency : enumOf(b, "currency", CURRENCIES),
    cliff_months: num(b, "cliff_months", { min: 0, max: 240 }),
    vest_duration_months: num(b, "vest_duration_months", { min: 1, max: 240 }),
    vest_frequency: enumOf(b, "vest_frequency", FREQUENCIES),
    notes: optStr(b, "notes", { max: 2000 }),
  };
  if (!grant.symbol) throw badRequest("symbol is required");
  if (grant.cliff_months > grant.vest_duration_months) {
    throw badRequest("The cliff cannot be longer than the whole vesting period");
  }
  return grant;
}

/** POST /api/rsu/grants — creates the grant and expands its schedule. */
rsuRouter.post("/grants", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const accountId = intParam(b.account_id, "account_id");
  const account = getAccount(db, accountId);
  if (!account) throw notFound("Account");

  const grant = buildGrant(b, account.currency);
  const r = db.prepare(
    `INSERT INTO rsu_grants (account_id, symbol, grant_date, total_units, grant_price_minor,
       currency, cliff_months, vest_duration_months, vest_frequency, notes)
     VALUES (@account_id, @symbol, @grant_date, @total_units, @grant_price_minor,
       @currency, @cliff_months, @vest_duration_months, @vest_frequency, @notes)`
  ).run({ ...grant, account_id: accountId });

  const id = r.lastInsertRowid as number;
  const row = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(id) as GrantRow;
  const tranches = rsu.generateVestRows(db, row);
  rsu.markVested(db, today());

  ok(res, { grant: row, tranches }, 201);
});

/**
 * PATCH /api/rsu/grants/:id — regenerates the schedule only when the shape of
 * the vesting changed, so editing a symbol or a note leaves entered prices alone.
 */
rsuRouter.patch("/grants/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(id) as GrantRow | undefined;
  if (!existing) throw notFound("Grant");

  const b = req.body as Record<string, unknown>;
  const account = getAccount(db, existing.account_id)!;
  const grant = buildGrant({ ...existing, ...b }, account.currency);

  const reshaped = SHAPE_KEYS.some(k => !absent(b, k) && String(b[k]) !== String(existing[k]));

  db.prepare(
    `UPDATE rsu_grants SET symbol = @symbol, grant_date = @grant_date, total_units = @total_units,
       grant_price_minor = @grant_price_minor, currency = @currency, cliff_months = @cliff_months,
       vest_duration_months = @vest_duration_months, vest_frequency = @vest_frequency, notes = @notes
     WHERE id = @id`
  ).run({ ...grant, id });

  const row = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(id) as GrantRow;
  let tranches: number | null = null;
  if (reshaped) {
    tranches = rsu.generateVestRows(db, row);
    rsu.markVested(db, today());
  }
  ok(res, { grant: row, regenerated: reshaped, tranches });
});

rsuRouter.delete("/grants/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(id);
  if (!existing) throw notFound("Grant");
  const vests = (db.prepare("SELECT COUNT(*) n FROM rsu_vests WHERE grant_id = ?")
    .get(id) as { n: number }).n;
  db.prepare("DELETE FROM rsu_grants WHERE id = ?").run(id);
  ok(res, { deleted: existing, cascaded: { vests } });
});

/** PATCH /api/rsu/vests/:id — the inline-editable tranche row. */
rsuRouter.patch("/vests/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM rsu_vests WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!existing) throw notFound("Vest");

  const b = req.body as Record<string, unknown>;
  const next = {
    vest_date: absent(b, "vest_date") ? existing.vest_date as IsoDate : date(b, "vest_date"),
    units: absent(b, "units") ? existing.units as number : num(b, "units", { min: Number.MIN_VALUE }),
    price_at_vest_minor: absent(b, "price_at_vest_minor")
      ? existing.price_at_vest_minor as number | null
      : optMinorInt(b, "price_at_vest_minor", { min: 0 }),
    units_sold_to_cover_tax: absent(b, "units_sold_to_cover_tax")
      ? existing.units_sold_to_cover_tax as number
      : num(b, "units_sold_to_cover_tax", { min: 0 }),
    status: absent(b, "status") ? existing.status as string : enumOf(b, "status", VEST_STATUSES),
    id,
  };

  if (next.units_sold_to_cover_tax > next.units) {
    throw badRequest("Units sold to cover tax cannot exceed the units that vested");
  }

  db.prepare(
    `UPDATE rsu_vests SET vest_date = @vest_date, units = @units,
       price_at_vest_minor = @price_at_vest_minor,
       units_sold_to_cover_tax = @units_sold_to_cover_tax, status = @status
     WHERE id = @id`
  ).run(next);

  ok(res, db.prepare("SELECT * FROM rsu_vests WHERE id = ?").get(id));
});

rsuRouter.delete("/vests/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM rsu_vests WHERE id = ?").get(id);
  if (!existing) throw notFound("Vest");
  db.prepare("DELETE FROM rsu_vests WHERE id = ?").run(id);
  ok(res, { deleted: existing });
});

/** POST /api/rsu/vests — add a tranche by hand (an off-schedule vest). */
rsuRouter.post("/vests", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const grantId = intParam(b.grant_id, "grant_id");
  if (!db.prepare("SELECT 1 FROM rsu_grants WHERE id = ?").get(grantId)) throw notFound("Grant");

  const row = {
    grant_id: grantId,
    vest_date: date(b, "vest_date"),
    units: num(b, "units", { min: Number.MIN_VALUE }),
    price_at_vest_minor: optMinorInt(b, "price_at_vest_minor", { min: 0 }),
    units_sold_to_cover_tax: absent(b, "units_sold_to_cover_tax")
      ? 0 : num(b, "units_sold_to_cover_tax", { min: 0 }),
    status: absent(b, "status") ? "scheduled" : enumOf(b, "status", VEST_STATUSES),
  };
  if (row.units_sold_to_cover_tax > row.units) {
    throw badRequest("Units sold to cover tax cannot exceed the units that vested");
  }

  try {
    const r = db.prepare(
      `INSERT INTO rsu_vests (grant_id, vest_date, units, price_at_vest_minor,
         units_sold_to_cover_tax, status)
       VALUES (@grant_id, @vest_date, @units, @price_at_vest_minor,
         @units_sold_to_cover_tax, @status)`
    ).run(row);
    ok(res, db.prepare("SELECT * FROM rsu_vests WHERE id = ?").get(r.lastInsertRowid), 201);
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) {
      throw badRequest(`This grant already has a tranche on ${row.vest_date}`);
    }
    throw e;
  }
});
