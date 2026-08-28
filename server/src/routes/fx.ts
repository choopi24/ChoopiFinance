/**
 * Manually-entered FX rates.
 *
 * Stored one-way (base → quote) and inverted on read when needed, so entering
 * "USD→ILS 3.72" is enough — there is no second row to keep consistent, and no
 * way for the two directions to drift apart.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { resolveFx, type Currency, type FxRow } from "../calc/index.js";
import { calcOptions } from "./_context.js";
import {
  CURRENCIES, absent, badRequest, date, enumOf, intParam, notFound, num, qDate, qInt,
} from "./_validate.js";

export const fxRouter = Router();
fxRouter.use(requireAuth);

/** GET /api/fx — the rate table, newest first. */
fxRouter.get("/", (req, res) => {
  const db = getDb();
  const limit = qInt(req, "limit", 50, 500);
  const offset = qInt(req, "offset", 0, 1_000_000);

  const total = (db.prepare("SELECT COUNT(*) n FROM fx_rates").get() as { n: number }).n;
  const rows = db.prepare(
    "SELECT * FROM fx_rates ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
  ).all(limit, offset);

  ok(res, { total, limit, offset, has_more: offset + rows.length < total, rates: rows });
});

/**
 * GET /api/fx/resolve?base=&quote=&on= — what the engine would actually use on
 * a given date, including whether it is a carried-forward stale rate. The
 * "needs attention" strip is built from exactly this.
 */
fxRouter.get("/resolve", (req, res) => {
  const db = getDb();
  const base = (req.query.base as Currency) ?? "USD";
  const quote = (req.query.quote as Currency) ?? "ILS";
  if (!CURRENCIES.includes(base) || !CURRENCIES.includes(quote)) {
    throw badRequest("base and quote must be ILS or USD");
  }
  const on = qDate(req, "on");
  const rows = db.prepare(
    "SELECT date, base_currency, quote_currency, rate FROM fx_rates ORDER BY date"
  ).all() as FxRow[];

  ok(res, { base, quote, on, ...resolveFx(rows, base, quote, on, calcOptions(db).staleFxDays) });
});

/** POST /api/fx — upsert on (date, base, quote). */
fxRouter.post("/", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const row = {
    date: date(b, "date"),
    base_currency: enumOf(b, "base_currency", CURRENCIES),
    quote_currency: enumOf(b, "quote_currency", CURRENCIES),
    rate: num(b, "rate", { min: Number.MIN_VALUE }),
  };
  if (row.base_currency === row.quote_currency) {
    throw badRequest("base and quote currency must differ");
  }

  db.prepare(
    `INSERT INTO fx_rates (date, base_currency, quote_currency, rate)
     VALUES (@date, @base_currency, @quote_currency, @rate)
     ON CONFLICT (date, base_currency, quote_currency) DO UPDATE SET rate = excluded.rate`
  ).run(row);

  ok(res, db.prepare(
    "SELECT * FROM fx_rates WHERE date = ? AND base_currency = ? AND quote_currency = ?"
  ).get(row.date, row.base_currency, row.quote_currency), 201);
});

fxRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM fx_rates WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!existing) throw notFound("FX rate");

  const b = req.body as Record<string, unknown>;
  const next = {
    date: absent(b, "date") ? existing.date as string : date(b, "date"),
    rate: absent(b, "rate") ? existing.rate as number : num(b, "rate", { min: Number.MIN_VALUE }),
    id,
  };

  try {
    db.prepare("UPDATE fx_rates SET date = @date, rate = @rate WHERE id = @id").run(next);
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) {
      throw badRequest(`There is already a rate for ${next.date} — edit that row instead`);
    }
    throw e;
  }
  ok(res, db.prepare("SELECT * FROM fx_rates WHERE id = ?").get(id));
});

fxRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM fx_rates WHERE id = ?").get(id);
  if (!existing) throw notFound("FX rate");
  db.prepare("DELETE FROM fx_rates WHERE id = ?").run(id);
  ok(res, { deleted: existing });
});
