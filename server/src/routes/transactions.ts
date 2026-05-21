import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { recomputeRealized } from "../services/fifo.js";
import { takeSnapshot } from "../services/snapshot.js";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const MARKET_KINDS = new Set(["BUY", "SELL", "DIV"]);
const MANUAL_KINDS = new Set(["UPDATE"]);
const MARKET_TYPES = new Set(["crypto", "stock", "etf"]);

// GET /api/transactions — paginated ledger
transactionsRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const page     = Math.max(1, Number(req.query.page ?? 1));
    const perPage  = Math.min(100, Math.max(1, Number(req.query.per_page ?? 20)));
    const offset   = (page - 1) * perPage;
    const invId    = req.query.investment_id ? Number(req.query.investment_id) : null;
    const kind     = req.query.kind as string | undefined;
    const from     = req.query.from as string | undefined;
    const to       = req.query.to   as string | undefined;

    const conditions: string[] = ["t.user_id = ?"];
    const params: unknown[] = [req.user!.id];

    if (invId)  { conditions.push("t.investment_id = ?"); params.push(invId); }
    if (kind)   { conditions.push("t.kind = ?");          params.push(kind); }
    if (from)   { conditions.push("t.occurred_at >= ?");  params.push(from); }
    if (to)     { conditions.push("t.occurred_at <= ?");  params.push(to); }

    const where = conditions.join(" AND ");

    const total = (db.prepare(
      `SELECT COUNT(*) as n FROM transactions t WHERE ${where}`
    ).get(...params) as { n: number }).n;

    const rows = db.prepare(
      `SELECT t.*, i.name AS investment_name, i.type AS investment_type, i.ticker
       FROM transactions t
       JOIN investments i ON i.id = t.investment_id
       WHERE ${where}
       ORDER BY t.occurred_at DESC, t.id DESC
       LIMIT ? OFFSET ?`
    ).all(...params, perPage, offset);

    ok(res, { data: rows, total, page, per_page: perPage });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/transactions — create BUY / SELL / DIV / UPDATE
transactionsRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const {
      investment_id, kind, units, price_per_unit, total_amount,
      currency = "NIS", wallet_id, occurred_at, notes,
      fx_rate_at_buy, force_separate = false,
    } = req.body as Record<string, unknown>;

    if (!investment_id || !kind || !currency || !occurred_at) {
      return fail(res, "investment_id, kind, currency, occurred_at are required");
    }

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(investment_id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    const isMarket = MARKET_TYPES.has(inv.type);

    // Validate kind matches investment type
    if (isMarket && MANUAL_KINDS.has(kind as string)) {
      return fail(res, `${inv.type} investments use BUY / SELL / DIV, not UPDATE`);
    }
    if (!isMarket && MARKET_KINDS.has(kind as string)) {
      return fail(res, `${inv.type} investments use UPDATE, not ${kind}`);
    }

    // Compute total_amount if not provided (BUY/SELL)
    let effectiveTotal = total_amount != null ? Number(total_amount) : null;
    if (effectiveTotal == null && units != null && price_per_unit != null) {
      effectiveTotal = Number(units) * Number(price_per_unit);
    }
    if (effectiveTotal == null || isNaN(effectiveTotal)) {
      return fail(res, "total_amount or (units + price_per_unit) required");
    }

    // ── Merge-candidate detection for BUY ───────────────────────────────────
    let merge_candidate: unknown = null;
    if (kind === "BUY" && !force_separate && inv.ticker) {
      const existing = db.prepare(
        `SELECT id, name, ticker, type, created_at FROM investments
         WHERE user_id = ? AND ticker = ? AND type = ? AND id != ?
           AND deleted_at IS NULL AND closed_at IS NULL`
      ).get(req.user!.id, inv.ticker, inv.type, investment_id);
      if (existing) merge_candidate = existing;
    }

    const result = db.prepare(
      `INSERT INTO transactions
         (investment_id, user_id, kind, units, price_per_unit, total_amount,
          currency, wallet_id, occurred_at, notes, fx_rate_at_buy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      investment_id, req.user!.id, kind,
      units ?? null, price_per_unit ?? null, effectiveTotal,
      currency, wallet_id ?? null, occurred_at, notes ?? null,
      kind === "BUY" ? (fx_rate_at_buy ?? null) : null
    );

    const txId = result.lastInsertRowid as number;

    // Recompute FIFO for SELL (sets realized_pl + updates closed_at)
    if (isMarket && (kind === "SELL" || kind === "BUY")) {
      recomputeRealized(db, Number(investment_id));
    }

    const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);

    // Snapshot portfolio after every market transaction so the history chart has fine-grained data
    takeSnapshot(db, req.user!.id);

    ok(res, { transaction: tx, merge_candidate }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/transactions/:id — edit (recomputes FIFO if SELL)
transactionsRouter.patch("/:id", (req, res) => {
  try {
    const db = getDb();
    const txId = Number(req.params.id);
    const tx = db.prepare(
      "SELECT * FROM transactions WHERE id = ? AND user_id = ?"
    ).get(txId, req.user!.id) as any;
    if (!tx) return fail(res, "Transaction not found", 404);

    const allowed = ["units", "price_per_unit", "total_amount", "currency",
                     "wallet_id", "occurred_at", "notes", "fx_rate_at_buy"];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        values.push(req.body[key] ?? null);
      }
    }
    if (updates.length === 0) return fail(res, "No valid fields to update");

    values.push(txId);
    db.prepare(`UPDATE transactions SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const inv = db.prepare("SELECT type FROM investments WHERE id = ?").get(tx.investment_id) as any;
    if (MARKET_TYPES.has(inv.type)) {
      recomputeRealized(db, tx.investment_id);
    }

    takeSnapshot(db, req.user!.id);

    const updated = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);
    ok(res, updated);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/transactions/:id/fifo-affected — count downstream SELLs affected by editing this tx
transactionsRouter.get("/:id/fifo-affected", (req, res) => {
  try {
    const db = getDb();
    const txId = Number(req.params.id);
    const tx = db.prepare(
      "SELECT * FROM transactions WHERE id = ? AND user_id = ?"
    ).get(txId, req.user!.id) as any;
    if (!tx) return fail(res, "Transaction not found", 404);

    // Count SELLs on the same investment that occurred after this transaction
    const row = db.prepare(
      `SELECT COUNT(*) as n FROM transactions
       WHERE investment_id = ? AND kind = 'SELL' AND occurred_at >= ?`
    ).get(tx.investment_id, tx.occurred_at) as { n: number };

    ok(res, { id: txId, affected_sells: row.n });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/transactions/:id — delete + recompute downstream
transactionsRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const txId = Number(req.params.id);
    const tx = db.prepare(
      "SELECT * FROM transactions WHERE id = ? AND user_id = ?"
    ).get(txId, req.user!.id) as any;
    if (!tx) return fail(res, "Transaction not found", 404);

    const investmentId: number = tx.investment_id;
    db.prepare("DELETE FROM transactions WHERE id = ?").run(txId);

    const inv = db.prepare("SELECT type FROM investments WHERE id = ?").get(investmentId) as any;
    if (inv && MARKET_TYPES.has(inv.type)) {
      recomputeRealized(db, investmentId);
    }

    takeSnapshot(db, req.user!.id);

    ok(res, { id: txId });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
