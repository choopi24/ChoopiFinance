/**
 * Recurring rules — the salary-funded deposits.
 *
 * The route layer only stores and edits rules; posting is `recurring.generateDue`,
 * which owns the idempotency guarantees. See calc/recurring.ts.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { getAccount, recurring, today } from "../calc/index.js";
import {
  CONTRIBUTION_PARTS, CURRENCIES, FREQUENCIES,
  absent, badRequest, bool, date, enumOf, intParam, minorInt, notFound,
  num, optDate, optEnumOf, optStr, qDate, qInt,
} from "./_validate.js";

export const recurringRouter = Router();
recurringRouter.use(requireAuth);

const SELECT = `
  SELECT r.*, a.name AS account_name, a.category AS account_category,
         (SELECT COUNT(*) FROM transactions t WHERE t.recurring_rule_id = r.id) AS posted_count
  FROM recurring_rules r JOIN accounts a ON a.id = r.account_id
`;

/** GET /api/recurring?account_id= */
recurringRouter.get("/", (req, res) => {
  const db = getDb();
  const rows = req.query.account_id
    ? db.prepare(`${SELECT} WHERE r.account_id = ? ORDER BY r.id`)
        .all(intParam(req.query.account_id, "account_id"))
    : db.prepare(`${SELECT} ORDER BY r.id`).all();
  ok(res, { rules: rows });
});

/** GET /api/recurring/upcoming?months= — what will post next, unposted. */
recurringRouter.get("/upcoming", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const months = qInt(req, "months", 3, 24);
  ok(res, { as_of: asOf, upcoming: recurring.previewUpcoming(db, asOf, months) });
});

/**
 * POST /api/recurring/generate — post everything active rules owe.
 * Called on boot and daily by the server; exposed so the phone can force it.
 */
recurringRouter.post("/generate", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  ok(res, recurring.generateDue(db, asOf));
});

function buildRule(b: Record<string, unknown>, accountCurrency: string) {
  const start = date(b, "start_date");
  const end = optDate(b, "end_date");
  if (end && end < start) throw badRequest("end_date cannot be before start_date");

  return {
    label: optStr(b, "label", { max: 120 }),
    frequency: absent(b, "frequency") ? "monthly" : enumOf(b, "frequency", FREQUENCIES),
    day_of_month: num(b, "day_of_month", { min: 1, max: 31 }),
    amount_minor: minorInt(b, "amount_minor", { min: 1 }),
    currency: absent(b, "currency") ? accountCurrency : enumOf(b, "currency", CURRENCIES),
    contribution_part: optEnumOf(b, "contribution_part", CONTRIBUTION_PARTS),
    start_date: start,
    end_date: end,
    auto_generate: bool(b, "auto_generate", true) ? 1 : 0,
    is_active: bool(b, "is_active", true) ? 1 : 0,
  };
}

/**
 * POST /api/recurring
 *
 * `backfill` decides what happens to the months between start_date and today.
 * Default false — creating a rule today should not silently invent a year of
 * deposits. Passing true sets the watermark back so the next generate posts
 * them all.
 */
recurringRouter.post("/", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const accountId = intParam(b.account_id, "account_id");
  const account = getAccount(db, accountId);
  if (!account) throw notFound("Account");

  const rule = buildRule(b, account.currency);
  const backfill = bool(b, "backfill", false);

  const r = db.prepare(
    `INSERT INTO recurring_rules (account_id, label, frequency, day_of_month, amount_minor,
       currency, contribution_part, start_date, end_date, auto_generate, is_active,
       last_generated_date)
     VALUES (@account_id, @label, @frequency, @day_of_month, @amount_minor,
       @currency, @contribution_part, @start_date, @end_date, @auto_generate, @is_active,
       @last_generated_date)`
  ).run({
    ...rule,
    account_id: accountId,
    // Watermark just before the start date backfills; today's date does not.
    last_generated_date: backfill ? null : today(),
  });

  const id = r.lastInsertRowid as number;
  const generated = backfill ? recurring.generateDue(db) : { created: 0 };
  ok(res, { rule: db.prepare(`${SELECT} WHERE r.id = ?`).get(id), generated }, 201);
});

recurringRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM recurring_rules WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  if (!existing) throw notFound("Recurring rule");

  const accountId = existing.account_id as number;
  const account = getAccount(db, accountId)!;
  const rule = buildRule({ ...existing, ...(req.body as object) }, account.currency);

  db.prepare(
    `UPDATE recurring_rules SET label = @label, frequency = @frequency,
       day_of_month = @day_of_month, amount_minor = @amount_minor, currency = @currency,
       contribution_part = @contribution_part, start_date = @start_date, end_date = @end_date,
       auto_generate = @auto_generate, is_active = @is_active
     WHERE id = @id`
  ).run({ ...rule, id });

  ok(res, db.prepare(`${SELECT} WHERE r.id = ?`).get(id));
});

/**
 * DELETE /api/recurring/:id — the rule only.
 *
 * Transactions it already posted survive: they are real money that really
 * moved. The FK is ON DELETE SET NULL, but that would violate the schema's
 * `(source='recurring') = (recurring_rule_id IS NOT NULL)` check, so they are
 * converted to manual rows first.
 */
recurringRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM recurring_rules WHERE id = ?").get(id);
  if (!existing) throw notFound("Recurring rule");

  const detached = db.transaction(() => {
    const n = db.prepare(
      "UPDATE transactions SET source = 'manual', recurring_rule_id = NULL WHERE recurring_rule_id = ?"
    ).run(id).changes;
    db.prepare("DELETE FROM recurring_rules WHERE id = ?").run(id);
    return n;
  })();

  ok(res, { deleted: existing, detached_transactions: detached });
});
