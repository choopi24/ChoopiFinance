import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { valueAccount, today, type AccountRow, type Currency } from "../services/valuation.js";
import { recomputeAccruals } from "../services/fees.js";
import {
  date, oneOf, positive, nonNegative, isErr,
  ENTRY_KINDS, FEE_KINDS, KINDS_FOR_MODE,
} from "./validate.js";

export const entriesRouter = Router();
entriesRouter.use(requireAuth);

function displayCcy(req: { user?: { display_currency?: string } }): Currency {
  return (req.user?.display_currency === "USD" ? "USD" : "ILS");
}

function loadAccount(db: ReturnType<typeof getDb>, id: number, userId: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?")
    .get(id, userId) as AccountRow | undefined;
}

/**
 * Shape-check a ledger row against its account's valuation mode. Rejecting the
 * wrong kind outright (rather than ignoring it during valuation) keeps the
 * decomposition unambiguous: on a market account principal arrives via `buy`,
 * on a balance account via `deposit`. Mixing the two would double-count.
 */
interface EntryFields {
  kind: string; occurred_on: string;
  amount: number | null; quantity: number | null; price_per_unit: number | null;
  fee_kind: string | null; period_start: string | null; period_end: string | null;
}

function parseEntry(
  account: AccountRow,
  b: Record<string, unknown>
): { value: EntryFields } | { error: string } {
  const kind = oneOf(b.kind, ENTRY_KINDS, "kind");
  if (isErr(kind)) return kind;

  const allowed = KINDS_FOR_MODE[account.valuation_mode];
  if (!allowed.includes(kind.value)) {
    return {
      error: `A ${account.valuation_mode}-valued account takes ${allowed.join(" / ")} entries, not "${kind.value}"`,
    };
  }

  const when = date(b.occurred_on ?? today(), "occurred_on");
  if (isErr(when)) return when;

  let amount: number | null = null;
  let quantity: number | null = null;
  let price_per_unit: number | null = null;
  let fee_kind: string | null = null;
  let period_start: string | null = null;
  let period_end: string | null = null;

  if (kind.value === "buy" || kind.value === "sell") {
    const q = positive(b.quantity, "quantity");
    if (isErr(q)) return q;
    const p = nonNegative(b.price_per_unit, "price_per_unit");
    if (isErr(p)) return p;
    quantity = q.value;
    price_per_unit = p.value;
    amount = q.value * p.value; // kept in sync so the ledger reads as money too
  } else {
    const a = nonNegative(b.amount, "amount");
    if (isErr(a)) return a;
    amount = a.value;
  }

  if (kind.value === "fee") {
    const fk = oneOf(b.fee_kind ?? "other", FEE_KINDS, "fee_kind");
    if (isErr(fk)) return fk;
    fee_kind = fk.value;
    // A period marks which months this statement fee covers, so accrued
    // estimates for those months step aside.
    if (b.period_start != null && b.period_start !== "") {
      const s = date(b.period_start, "period_start");
      if (isErr(s)) return s;
      period_start = s.value;
    }
    if (b.period_end != null && b.period_end !== "") {
      const e = date(b.period_end, "period_end");
      if (isErr(e)) return e;
      period_end = e.value;
    }
    if (period_start && period_end && period_start > period_end) {
      return { error: "period_start must be on or before period_end" };
    }
  }

  return { value: { kind: kind.value, occurred_on: when.value, amount, quantity, price_per_unit, fee_kind, period_start, period_end } };
}

// GET /api/entries?account_id=&kind=&limit=
entriesRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const where: string[] = ["e.user_id = ?"];
    const params: unknown[] = [req.user!.id];

    if (req.query.account_id) { where.push("e.account_id = ?"); params.push(Number(req.query.account_id)); }
    if (req.query.kind)       { where.push("e.kind = ?");       params.push(String(req.query.kind)); }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));

    const rows = db.prepare(
      `SELECT e.*, a.name AS account_name, a.currency AS account_currency, a.kind AS account_kind
       FROM entries e JOIN accounts a ON a.id = e.account_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.occurred_on DESC, e.id DESC
       LIMIT ?`
    ).all(...params, limit);

    ok(res, rows);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/entries — add a ledger row
entriesRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as Record<string, unknown>;
    const account = loadAccount(db, Number(b.account_id), req.user!.id);
    if (!account) return fail(res, "Account not found", 404);

    const parsed = parseEntry(account, b);
    if ("error" in parsed) return fail(res, parsed.error);
    const f = parsed.value;

    const id = db.prepare(
      `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, quantity,
                            price_per_unit, source, fee_kind, is_estimate,
                            period_start, period_end, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, 0, ?, ?, ?)`
    ).run(
      account.id, req.user!.id, f.kind, f.occurred_on, f.amount, f.quantity,
      f.price_per_unit, f.fee_kind, f.period_start, f.period_end,
      typeof b.note === "string" && b.note.trim() ? b.note.trim() : null
    ).lastInsertRowid as number;

    // Deposits change the accrual base; a real fee may supersede estimates.
    recomputeAccruals(db, account);

    ok(res, {
      entry: db.prepare("SELECT * FROM entries WHERE id = ?").get(id),
      valuation: valueAccount(db, account, displayCcy(req), today()),
    }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/entries/:id — partial edit; only the fields sent change
entriesRouter.patch("/:id", (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare(
      "SELECT * FROM entries WHERE id = ? AND user_id = ?"
    ).get(Number(req.params.id), req.user!.id) as Record<string, unknown> | undefined;
    if (!existing) return fail(res, "Entry not found", 404);
    if (existing.is_estimate === 1) {
      return fail(res, "That fee is an automatic estimate — record the real fee from your statement instead, and the estimate steps aside");
    }

    const account = loadAccount(db, Number(existing.account_id), req.user!.id)!;
    const b = req.body as Record<string, unknown>;

    // Merge over the existing row, then re-validate the whole shape so an edit
    // can never leave a half-specified entry behind.
    const merged = {
      kind: b.kind ?? existing.kind,
      occurred_on: b.occurred_on ?? existing.occurred_on,
      amount: "amount" in b ? b.amount : existing.amount,
      quantity: "quantity" in b ? b.quantity : existing.quantity,
      price_per_unit: "price_per_unit" in b ? b.price_per_unit : existing.price_per_unit,
      fee_kind: "fee_kind" in b ? b.fee_kind : existing.fee_kind,
      period_start: "period_start" in b ? b.period_start : existing.period_start,
      period_end: "period_end" in b ? b.period_end : existing.period_end,
    };
    const parsed = parseEntry(account, merged);
    if ("error" in parsed) return fail(res, parsed.error);
    const f = parsed.value;

    db.prepare(
      `UPDATE entries SET kind = ?, occurred_on = ?, amount = ?, quantity = ?,
                          price_per_unit = ?, fee_kind = ?, period_start = ?,
                          period_end = ?, note = ?
       WHERE id = ?`
    ).run(
      f.kind, f.occurred_on, f.amount, f.quantity, f.price_per_unit,
      f.fee_kind, f.period_start, f.period_end,
      "note" in b ? (typeof b.note === "string" && b.note.trim() ? b.note.trim() : null) : existing.note,
      existing.id
    );

    recomputeAccruals(db, account);

    ok(res, {
      entry: db.prepare("SELECT * FROM entries WHERE id = ?").get(existing.id as number),
      valuation: valueAccount(db, account, displayCcy(req), today()),
    });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/entries/:id
entriesRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const existing = db.prepare(
      "SELECT * FROM entries WHERE id = ? AND user_id = ?"
    ).get(Number(req.params.id), req.user!.id) as { id: number; account_id: number } | undefined;
    if (!existing) return fail(res, "Entry not found", 404);

    const account = loadAccount(db, existing.account_id, req.user!.id)!;
    db.prepare("DELETE FROM entries WHERE id = ?").run(existing.id);
    recomputeAccruals(db, account);

    ok(res, { id: existing.id, valuation: valueAccount(db, account, displayCcy(req), today()) });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
