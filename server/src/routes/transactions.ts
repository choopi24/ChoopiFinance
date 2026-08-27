/**
 * The transaction ledger.
 *
 * The client always sends a POSITIVE amount and lets the type carry the
 * direction — nobody typing "12.50" into a fee field on a phone should have to
 * remember a minus sign. `signFor` applies the sign the schema's CHECK
 * constraints demand. 'adjustment' is the one exception: it is a correcting
 * entry, so its sign is meaningful and passes through untouched.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { getAccount } from "../calc/index.js";
import {
  CONTRIBUTION_PARTS, CURRENCIES, FEE_KINDS, TX_TYPES,
  absent, badRequest, date, enumOf, intParam, minorInt, notFound, num,
  optEnumOf, optNum, optStr, qDate, qInt,
} from "./_validate.js";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

type TxType = typeof TX_TYPES[number];

const NEGATIVE: ReadonlySet<TxType> = new Set(["withdrawal", "buy", "fee"] as const);

function signFor(type: TxType, magnitude: number): number {
  if (type === "adjustment") return magnitude;
  const abs = Math.abs(magnitude);
  if (abs === 0) throw badRequest("amount_minor must not be zero");
  return NEGATIVE.has(type) ? -abs : abs;
}

const SELECT = `
  SELECT t.*, a.name AS account_name, a.category AS account_category,
         h.symbol AS holding_symbol
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN holdings h ON h.id = t.holding_id
`;

/**
 * GET /api/transactions — newest first, paged.
 * `limit`/`offset` are mandatory in spirit: the account detail screen must
 * never be handed a 500-row dump.
 */
transactionsRouter.get("/", (req, res) => {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (req.query.account_id) {
    params.account_id = intParam(req.query.account_id, "account_id");
    where.push("t.account_id = @account_id");
  }
  if (req.query.holding_id) {
    params.holding_id = intParam(req.query.holding_id, "holding_id");
    where.push("t.holding_id = @holding_id");
  }
  if (req.query.type) {
    const types = String(req.query.type).split(",");
    for (const t of types) {
      if (!TX_TYPES.includes(t as TxType)) throw badRequest(`Unknown type "${t}"`);
    }
    where.push(`t.type IN (${types.map((_, i) => `@type${i}`).join(", ")})`);
    types.forEach((t, i) => { params[`type${i}`] = t; });
  }
  if (req.query.from) { params.from = qDate(req, "from"); where.push("t.date >= @from"); }
  if (req.query.to)   { params.to   = qDate(req, "to");   where.push("t.date <= @to"); }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = qInt(req, "limit", 50, 500);
  const offset = qInt(req, "offset", 0, 1_000_000);

  // The clause only ever references `t.`, so the count can skip the joins.
  const total = (db.prepare(
    `SELECT COUNT(*) n FROM transactions t ${clause}`
  ).get(params) as { n: number }).n;

  const rows = db.prepare(
    `${SELECT} ${clause} ORDER BY t.date DESC, t.id DESC LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset });

  ok(res, { total, limit, offset, has_more: offset + rows.length < total, transactions: rows });
});

function buildTx(b: Record<string, unknown>, accountCurrency: string) {
  const type = enumOf(b, "type", TX_TYPES);
  const isTrade = type === "buy" || type === "sell";

  if (type === "fee" && absent(b, "fee_kind")) {
    throw badRequest("fee_kind is required for a fee — fee drag can only be attributed if you say which kind");
  }

  return {
    date: date(b, "date"),
    type,
    amount_minor: signFor(type, minorInt(b, "amount_minor")),
    holding_id: isTrade ? intParam(b.holding_id, "holding_id") : null,
    quantity: isTrade ? num(b, "quantity", { min: Number.MIN_VALUE }) : null,
    price_minor: isTrade ? minorInt(b, "price_minor", { min: 0 }) : null,
    contribution_part: type === "deposit" ? optEnumOf(b, "contribution_part", CONTRIBUTION_PARTS) : null,
    fee_kind: type === "fee" ? enumOf(b, "fee_kind", FEE_KINDS) : null,
    currency: absent(b, "currency") ? accountCurrency : enumOf(b, "currency", CURRENCIES),
    note: optStr(b, "note", { max: 500 }),
  };
}

/** POST /api/transactions */
transactionsRouter.post("/", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const accountId = intParam(b.account_id, "account_id");
  const account = getAccount(db, accountId);
  if (!account) throw notFound("Account");

  const tx = buildTx(b, account.currency);
  if (tx.holding_id != null) {
    const h = db.prepare("SELECT account_id FROM holdings WHERE id = ?").get(tx.holding_id) as
      { account_id: number } | undefined;
    if (!h) throw notFound("Holding");
    if (h.account_id !== accountId) throw badRequest("That holding belongs to a different account");
  }

  const r = db.prepare(
    `INSERT INTO transactions (account_id, holding_id, date, type, amount_minor, quantity,
       price_minor, contribution_part, fee_kind, currency, source, note)
     VALUES (@account_id, @holding_id, @date, @type, @amount_minor, @quantity,
       @price_minor, @contribution_part, @fee_kind, @currency, 'manual', @note)`
  ).run({ ...tx, account_id: accountId });

  ok(res, db.prepare(`${SELECT} WHERE t.id = ?`).get(r.lastInsertRowid), 201);
});

/**
 * PATCH /api/transactions/:id — the inline-edit endpoint.
 *
 * Rebuilt from the merged row rather than patched column-by-column: the
 * schema's cross-column CHECKs (a buy needs units AND a price) can only be
 * validated against the whole row, so a partial update has to be resolved to a
 * complete one first.
 */
transactionsRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!existing) throw notFound("Transaction");

  const b = req.body as Record<string, unknown>;
  const accountId = absent(b, "account_id") ? existing.account_id as number : intParam(b.account_id, "account_id");
  const account = getAccount(db, accountId);
  if (!account) throw notFound("Account");

  // Merge, but send the stored amount back through as a magnitude so signFor
  // stays the single authority on direction.
  const merged: Record<string, unknown> = {
    ...existing,
    amount_minor: Math.abs(existing.amount_minor as number),
    ...b,
  };
  const tx = buildTx(merged, account.currency);

  db.prepare(
    `UPDATE transactions SET account_id = @account_id, holding_id = @holding_id, date = @date,
       type = @type, amount_minor = @amount_minor, quantity = @quantity, price_minor = @price_minor,
       contribution_part = @contribution_part, fee_kind = @fee_kind, currency = @currency, note = @note
     WHERE id = @id`
  ).run({ ...tx, account_id: accountId, id });

  ok(res, db.prepare(`${SELECT} WHERE t.id = ?`).get(id));
});

/**
 * POST /api/transactions/restore — the other half of undo.
 *
 * Re-inserts a row exactly as DELETE returned it, provenance included, so
 * undoing the deletion of an auto-generated salary deposit gives back an
 * auto-generated deposit rather than a manual look-alike. The unique index on
 * (recurring_rule_id, date) still stops a rule from double-posting.
 */
transactionsRouter.post("/restore", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const accountId = intParam(b.account_id, "account_id");
  if (!getAccount(db, accountId)) throw notFound("Account");

  const ruleId = b.recurring_rule_id == null ? null : intParam(b.recurring_rule_id, "recurring_rule_id");
  const row = {
    account_id: accountId,
    holding_id: b.holding_id == null ? null : intParam(b.holding_id, "holding_id"),
    date: date(b, "date"),
    type: enumOf(b, "type", TX_TYPES),
    amount_minor: minorInt(b, "amount_minor"),
    quantity: optNum(b, "quantity"),
    price_minor: b.price_minor == null ? null : minorInt(b, "price_minor", { min: 0 }),
    contribution_part: optEnumOf(b, "contribution_part", CONTRIBUTION_PARTS),
    fee_kind: optEnumOf(b, "fee_kind", FEE_KINDS),
    currency: enumOf(b, "currency", CURRENCIES),
    source: ruleId == null ? "manual" : "recurring",
    recurring_rule_id: ruleId,
    note: optStr(b, "note", { max: 500 }),
  };

  const r = db.prepare(
    `INSERT INTO transactions (account_id, holding_id, date, type, amount_minor, quantity,
       price_minor, contribution_part, fee_kind, currency, source, recurring_rule_id, note)
     VALUES (@account_id, @holding_id, @date, @type, @amount_minor, @quantity,
       @price_minor, @contribution_part, @fee_kind, @currency, @source, @recurring_rule_id, @note)`
  ).run(row);

  ok(res, db.prepare(`${SELECT} WHERE t.id = ?`).get(r.lastInsertRowid), 201);
});

/** DELETE /api/transactions/:id — returns the row so the client can undo it. */
transactionsRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
  if (!existing) throw notFound("Transaction");
  db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
  ok(res, { deleted: existing });
});
