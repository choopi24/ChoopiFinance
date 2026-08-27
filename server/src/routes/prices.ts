/**
 * Manually-entered price points, and manually-entered balance snapshots.
 *
 * Both are dated series read with carry-forward, never caches — so POSTing the
 * same date twice is an UPSERT, not a duplicate. Correcting a typo is the
 * common case on a phone; creating a second conflicting row for the same day
 * never is.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { getAccount } from "../calc/index.js";
import {
  CURRENCIES, absent, badRequest, date, enumOf, intParam, minorInt, notFound, qInt,
} from "./_validate.js";

export const pricesRouter = Router();
pricesRouter.use(requireAuth);

/** GET /api/prices?holding_id=&limit=&offset= — newest first. */
pricesRouter.get("/", (req, res) => {
  const db = getDb();
  const holdingId = intParam(req.query.holding_id, "holding_id");
  const limit = qInt(req, "limit", 50, 500);
  const offset = qInt(req, "offset", 0, 1_000_000);

  const total = (db.prepare("SELECT COUNT(*) n FROM prices WHERE holding_id = ?")
    .get(holdingId) as { n: number }).n;
  const rows = db.prepare(
    "SELECT * FROM prices WHERE holding_id = ? ORDER BY date DESC LIMIT ? OFFSET ?"
  ).all(holdingId, limit, offset);

  ok(res, { total, limit, offset, has_more: offset + rows.length < total, prices: rows });
});

/** POST /api/prices — upsert on (holding_id, date). */
pricesRouter.post("/", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const holdingId = intParam(b.holding_id, "holding_id");
  const holding = db.prepare("SELECT * FROM holdings WHERE id = ?").get(holdingId) as
    { currency: string } | undefined;
  if (!holding) throw notFound("Holding");

  const row = {
    holding_id: holdingId,
    date: date(b, "date"),
    price_minor: minorInt(b, "price_minor", { min: 0 }),
    currency: absent(b, "currency") ? holding.currency : enumOf(b, "currency", CURRENCIES),
  };

  db.prepare(
    `INSERT INTO prices (holding_id, date, price_minor, currency)
     VALUES (@holding_id, @date, @price_minor, @currency)
     ON CONFLICT (holding_id, date) DO UPDATE SET
       price_minor = excluded.price_minor, currency = excluded.currency`
  ).run(row);

  ok(res, db.prepare("SELECT * FROM prices WHERE holding_id = ? AND date = ?")
    .get(holdingId, row.date), 201);
});

pricesRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM prices WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!existing) throw notFound("Price");

  const b = req.body as Record<string, unknown>;
  const next = {
    date: absent(b, "date") ? existing.date as string : date(b, "date"),
    price_minor: absent(b, "price_minor") ? existing.price_minor as number : minorInt(b, "price_minor", { min: 0 }),
    currency: absent(b, "currency") ? existing.currency as string : enumOf(b, "currency", CURRENCIES),
    id,
  };

  try {
    db.prepare("UPDATE prices SET date = @date, price_minor = @price_minor, currency = @currency WHERE id = @id")
      .run(next);
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) {
      throw badRequest(`There is already a price for ${next.date} — edit that row instead`);
    }
    throw e;
  }
  ok(res, db.prepare("SELECT * FROM prices WHERE id = ?").get(id));
});

pricesRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM prices WHERE id = ?").get(id);
  if (!existing) throw notFound("Price");
  db.prepare("DELETE FROM prices WHERE id = ?").run(id);
  ok(res, { deleted: existing });
});

// ── balance snapshots ────────────────────────────────────────────────────────

export const valuationsRouter = Router();
valuationsRouter.use(requireAuth);

valuationsRouter.get("/", (req, res) => {
  const db = getDb();
  const accountId = intParam(req.query.account_id, "account_id");
  const limit = qInt(req, "limit", 50, 500);
  const offset = qInt(req, "offset", 0, 1_000_000);

  const total = (db.prepare("SELECT COUNT(*) n FROM valuations WHERE account_id = ?")
    .get(accountId) as { n: number }).n;
  const rows = db.prepare(
    "SELECT * FROM valuations WHERE account_id = ? ORDER BY date DESC LIMIT ? OFFSET ?"
  ).all(accountId, limit, offset);

  ok(res, { total, limit, offset, has_more: offset + rows.length < total, valuations: rows });
});

/** POST /api/valuations — upsert on (account_id, date). */
valuationsRouter.post("/", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const accountId = intParam(b.account_id, "account_id");
  const account = getAccount(db, accountId);
  if (!account) throw notFound("Account");

  const row = {
    account_id: accountId,
    date: date(b, "date"),
    balance_minor: minorInt(b, "balance_minor", { min: 0 }),
    currency: absent(b, "currency") ? account.currency : enumOf(b, "currency", CURRENCIES),
  };

  db.prepare(
    `INSERT INTO valuations (account_id, date, balance_minor, currency)
     VALUES (@account_id, @date, @balance_minor, @currency)
     ON CONFLICT (account_id, date) DO UPDATE SET
       balance_minor = excluded.balance_minor, currency = excluded.currency`
  ).run(row);

  ok(res, db.prepare("SELECT * FROM valuations WHERE account_id = ? AND date = ?")
    .get(accountId, row.date), 201);
});

valuationsRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM valuations WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!existing) throw notFound("Balance snapshot");

  const b = req.body as Record<string, unknown>;
  const next = {
    date: absent(b, "date") ? existing.date as string : date(b, "date"),
    balance_minor: absent(b, "balance_minor") ? existing.balance_minor as number : minorInt(b, "balance_minor", { min: 0 }),
    currency: absent(b, "currency") ? existing.currency as string : enumOf(b, "currency", CURRENCIES),
    id,
  };

  try {
    db.prepare("UPDATE valuations SET date = @date, balance_minor = @balance_minor, currency = @currency WHERE id = @id")
      .run(next);
  } catch (e) {
    if (String((e as Error).message).includes("UNIQUE")) {
      throw badRequest(`There is already a balance for ${next.date} — edit that row instead`);
    }
    throw e;
  }
  ok(res, db.prepare("SELECT * FROM valuations WHERE id = ?").get(id));
});

valuationsRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM valuations WHERE id = ?").get(id);
  if (!existing) throw notFound("Balance snapshot");
  db.prepare("DELETE FROM valuations WHERE id = ?").run(id);
  ok(res, { deleted: existing });
});
