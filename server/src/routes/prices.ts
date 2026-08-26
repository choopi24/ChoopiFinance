import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { priceOnOrBefore, today } from "../services/valuation.js";
import { recomputeAllAccruals } from "../services/fees.js";
import { date, positive, oneOf, symbol as normSymbol, isErr, CURRENCIES } from "./validate.js";

export const pricesRouter = Router();
pricesRouter.use(requireAuth);

// GET /api/prices — the symbols you track, each with its latest entered price.
// Drives the "update prices" screen: one row per symbol, newest first.
pricesRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const asOf = req.query.as_of ? String(req.query.as_of).slice(0, 10) : today();

    const symbols = db.prepare(
      `SELECT DISTINCT symbol FROM accounts
       WHERE user_id = ? AND symbol IS NOT NULL AND archived_at IS NULL
       ORDER BY symbol`
    ).all(req.user!.id) as { symbol: string }[];

    ok(res, symbols.map(({ symbol }) => {
      const latest = priceOnOrBefore(db, req.user!.id, symbol, asOf);
      const staleDays = latest
        ? Math.floor((new Date(asOf).getTime() - new Date(latest.as_of).getTime()) / 86_400_000)
        : null;
      return {
        symbol,
        price: latest?.price ?? null,
        currency: latest?.currency ?? null,
        as_of: latest?.as_of ?? null,
        stale_days: staleDays,
      };
    }));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/prices/:symbol — full history for one symbol
pricesRouter.get("/:symbol", (req, res) => {
  try {
    const db = getDb();
    const sym = normSymbol(req.params.symbol);
    if (!sym) return fail(res, "symbol is required");
    ok(res, db.prepare(
      `SELECT * FROM price_points WHERE user_id = ? AND symbol = ?
       ORDER BY as_of DESC LIMIT 500`
    ).all(req.user!.id, sym));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/prices — record a price. Re-posting the same symbol+date overwrites,
// so a typo is fixed by simply entering it again.
pricesRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as Record<string, unknown>;

    const sym = normSymbol(b.symbol);
    if (!sym) return fail(res, "symbol is required");
    const price = positive(b.price, "price");
    if (isErr(price)) return fail(res, price.error);
    const ccy = oneOf(b.currency ?? "ILS", CURRENCIES, "currency");
    if (isErr(ccy)) return fail(res, ccy.error);
    const asOf = date(b.as_of ?? today(), "as_of");
    if (isErr(asOf)) return fail(res, asOf.error);

    db.prepare(
      `INSERT INTO price_points (user_id, symbol, price, currency, as_of, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, symbol, as_of)
       DO UPDATE SET price = excluded.price, currency = excluded.currency, note = excluded.note`
    ).run(req.user!.id, sym, price.value, ccy.value, asOf.value,
          typeof b.note === "string" && b.note.trim() ? b.note.trim() : null);

    // A new price moves the balance-fee accrual base for market accounts.
    recomputeAllAccruals(db, req.user!.id);

    ok(res, db.prepare(
      "SELECT * FROM price_points WHERE user_id = ? AND symbol = ? AND as_of = ?"
    ).get(req.user!.id, sym, asOf.value), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/prices/bulk — one round-trip for the "update all prices" screen
pricesRouter.post("/bulk", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as { as_of?: string; prices?: Record<string, unknown>[] };
    if (!Array.isArray(b.prices) || b.prices.length === 0) {
      return fail(res, "prices must be a non-empty array");
    }
    const defaultDate = date(b.as_of ?? today(), "as_of");
    if (isErr(defaultDate)) return fail(res, defaultDate.error);

    const rows: { symbol: string; price: number; currency: string; as_of: string }[] = [];
    for (let i = 0; i < b.prices.length; i++) {
      const p = b.prices[i];
      const sym = normSymbol(p.symbol);
      if (!sym) return fail(res, `prices[${i}].symbol is required`);
      const price = positive(p.price, `prices[${i}].price`);
      if (isErr(price)) return fail(res, price.error);
      const ccy = oneOf(p.currency ?? "ILS", CURRENCIES, `prices[${i}].currency`);
      if (isErr(ccy)) return fail(res, ccy.error);
      const when = date(p.as_of ?? defaultDate.value, `prices[${i}].as_of`);
      if (isErr(when)) return fail(res, when.error);
      rows.push({ symbol: sym, price: price.value, currency: ccy.value, as_of: when.value });
    }

    const stmt = db.prepare(
      `INSERT INTO price_points (user_id, symbol, price, currency, as_of)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, symbol, as_of)
       DO UPDATE SET price = excluded.price, currency = excluded.currency`
    );
    db.transaction(() => {
      for (const r of rows) stmt.run(req.user!.id, r.symbol, r.price, r.currency, r.as_of);
    })();

    recomputeAllAccruals(db, req.user!.id);
    ok(res, { saved: rows.length }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/prices/:id
pricesRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare(
      "DELETE FROM price_points WHERE id = ? AND user_id = ?"
    ).run(Number(req.params.id), req.user!.id);
    if (r.changes === 0) return fail(res, "Price point not found", 404);
    recomputeAllAccruals(db, req.user!.id);
    ok(res, { id: Number(req.params.id) });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
