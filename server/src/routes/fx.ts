import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { conversion, today, type Currency } from "../services/valuation.js";
import { date, positive, oneOf, isErr, CURRENCIES } from "./validate.js";

export const fxRouter = Router();
fxRouter.use(requireAuth);

// GET /api/fx — history plus the rate currently in force
fxRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const asOf = req.query.as_of ? String(req.query.as_of).slice(0, 10) : today();
    const current = conversion(db, req.user!.id, "USD", "ILS", asOf);

    ok(res, {
      as_of: asOf,
      usd_ils: current.missing ? null : current.rate,
      missing: current.missing,
      history: db.prepare(
        `SELECT * FROM fx_rates WHERE user_id = ? ORDER BY as_of DESC LIMIT 200`
      ).all(req.user!.id),
    });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/fx — record a rate. Same base/quote/date overwrites.
fxRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as Record<string, unknown>;

    const base = oneOf(b.base ?? "USD", CURRENCIES, "base");
    if (isErr(base)) return fail(res, base.error);
    const quote = oneOf(b.quote ?? "ILS", CURRENCIES, "quote");
    if (isErr(quote)) return fail(res, quote.error);
    if (base.value === quote.value) return fail(res, "base and quote must differ");

    const rate = positive(b.rate, "rate");
    if (isErr(rate)) return fail(res, rate.error);
    const asOf = date(b.as_of ?? today(), "as_of");
    if (isErr(asOf)) return fail(res, asOf.error);

    db.prepare(
      `INSERT INTO fx_rates (user_id, base, quote, rate, as_of, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, base, quote, as_of)
       DO UPDATE SET rate = excluded.rate, note = excluded.note`
    ).run(req.user!.id, base.value, quote.value, rate.value, asOf.value,
          typeof b.note === "string" && b.note.trim() ? b.note.trim() : null);

    ok(res, db.prepare(
      "SELECT * FROM fx_rates WHERE user_id = ? AND base = ? AND quote = ? AND as_of = ?"
    ).get(req.user!.id, base.value, quote.value, asOf.value), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/fx/:id
fxRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare("DELETE FROM fx_rates WHERE id = ? AND user_id = ?")
      .run(Number(req.params.id), req.user!.id);
    if (r.changes === 0) return fail(res, "Rate not found", 404);
    ok(res, { id: Number(req.params.id) });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
