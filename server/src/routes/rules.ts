import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { generateDueDeposits } from "../services/rules.js";
import { recomputeAllAccruals } from "../services/fees.js";
import { valueAccount, today, type AccountRow, type Currency } from "../services/valuation.js";
import { date, positive, oneOf, isErr, CURRENCIES } from "./validate.js";

export const rulesRouter = Router();
rulesRouter.use(requireAuth);

function displayCcy(req: { user?: { display_currency?: string } }): Currency {
  return (req.user?.display_currency === "USD" ? "USD" : "ILS");
}

// GET /api/rules
rulesRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    ok(res, db.prepare(
      `SELECT r.*, a.name AS account_name FROM deposit_rules r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.user_id = ? ORDER BY a.name, r.id`
    ).all(req.user!.id));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rules — a fixed monthly deposit for a salary-funded account
rulesRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as Record<string, unknown>;

    const account = db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?")
      .get(Number(b.account_id), req.user!.id) as AccountRow | undefined;
    if (!account) return fail(res, "Account not found", 404);

    const amount = positive(b.amount, "amount");
    if (isErr(amount)) return fail(res, amount.error);
    const ccy = oneOf(b.currency ?? account.currency, CURRENCIES, "currency");
    if (isErr(ccy)) return fail(res, ccy.error);
    // The ledger stores amounts in the account's own currency; a rule in another
    // currency would need an FX rate at post time and silently drift.
    if (ccy.value !== account.currency) {
      return fail(res, `This account is in ${account.currency}, so its deposit rule must be too`);
    }
    const day = Number(b.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return fail(res, "day_of_month must be a whole number from 1 to 31");
    }
    const startOn = date(b.start_on ?? today(), "start_on");
    if (isErr(startOn)) return fail(res, startOn.error);
    let endOn: string | null = null;
    if (b.end_on != null && b.end_on !== "") {
      const e = date(b.end_on, "end_on");
      if (isErr(e)) return fail(res, e.error);
      if (e.value < startOn.value) return fail(res, "end_on must be on or after start_on");
      endOn = e.value;
    }

    const id = db.prepare(
      `INSERT INTO deposit_rules (account_id, user_id, amount, currency, day_of_month, start_on, end_on, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(account.id, req.user!.id, amount.value, ccy.value, day, startOn.value, endOn,
          typeof b.note === "string" && b.note.trim() ? b.note.trim() : null)
      .lastInsertRowid as number;

    // Post everything the rule already owes, right away.
    const gen = generateDueDeposits(db, req.user!.id);
    recomputeAllAccruals(db, req.user!.id);

    ok(res, {
      rule: db.prepare("SELECT * FROM deposit_rules WHERE id = ?").get(id),
      generated: gen.created,
      valuation: valueAccount(db, account, displayCcy(req), today()),
    }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/rules/:id — pause, retire, or adjust a rule
rulesRouter.patch("/:id", (req, res) => {
  try {
    const db = getDb();
    const rule = db.prepare("SELECT * FROM deposit_rules WHERE id = ? AND user_id = ?")
      .get(Number(req.params.id), req.user!.id) as Record<string, unknown> | undefined;
    if (!rule) return fail(res, "Rule not found", 404);

    const b = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];

    if ("amount" in b) {
      const r = positive(b.amount, "amount");
      if (isErr(r)) return fail(res, r.error);
      sets.push("amount = ?"); vals.push(r.value);
    }
    if ("day_of_month" in b) {
      const day = Number(b.day_of_month);
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        return fail(res, "day_of_month must be a whole number from 1 to 31");
      }
      sets.push("day_of_month = ?"); vals.push(day);
    }
    if ("end_on" in b) {
      if (b.end_on == null || b.end_on === "") {
        sets.push("end_on = ?"); vals.push(null);
      } else {
        const r = date(b.end_on, "end_on");
        if (isErr(r)) return fail(res, r.error);
        sets.push("end_on = ?"); vals.push(r.value);
      }
    }
    if ("active" in b) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
    if ("note" in b) {
      sets.push("note = ?");
      vals.push(typeof b.note === "string" && b.note.trim() ? b.note.trim() : null);
    }
    if (sets.length === 0) return fail(res, "No valid fields to update");

    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    vals.push(rule.id);
    db.prepare(`UPDATE deposit_rules SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

    ok(res, db.prepare("SELECT * FROM deposit_rules WHERE id = ?").get(rule.id as number));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/rules/:id?keep_deposits=true
// Deposits already posted are real money that landed — kept unless you say otherwise.
rulesRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const rule = db.prepare("SELECT * FROM deposit_rules WHERE id = ? AND user_id = ?")
      .get(Number(req.params.id), req.user!.id) as { id: number; account_id: number } | undefined;
    if (!rule) return fail(res, "Rule not found", 404);

    const keep = req.query.keep_deposits !== "false";
    db.transaction(() => {
      if (!keep) {
        db.prepare("DELETE FROM entries WHERE rule_id = ?").run(rule.id);
      }
      db.prepare("DELETE FROM deposit_rules WHERE id = ?").run(rule.id);
    })();
    recomputeAllAccruals(db, req.user!.id);

    ok(res, { id: rule.id, deposits_kept: keep });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/rules/generate — post any deposits that have come due
rulesRouter.post("/generate", (req, res) => {
  try {
    const db = getDb();
    const result = generateDueDeposits(db, req.user!.id);
    if (result.created > 0) recomputeAllAccruals(db, req.user!.id);
    ok(res, result);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
