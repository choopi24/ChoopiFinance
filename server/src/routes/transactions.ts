import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { recomputeRealized } from "../services/fifo.js";
import { takeSnapshot } from "../services/snapshot.js";
import { refreshPrice } from "../services/prices.js";
import { getRateSync } from "../services/fx.js";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const MARKET_KINDS = new Set(["BUY", "SELL", "DIV"]);
// UPDATE = balance snapshot; DEPOSIT = actual cash contribution (education/other P/L model)
const MANUAL_KINDS = new Set(["UPDATE", "DEPOSIT"]);
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
transactionsRouter.post("/", async (req, res) => {
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
      return fail(res, `${inv.type} investments use BUY / SELL / DIV, not ${kind}`);
    }
    if (!isMarket && MARKET_KINDS.has(kind as string)) {
      return fail(res, `${inv.type} investments use UPDATE / DEPOSIT, not ${kind}`);
    }

    // Normalised, possibly-derived position fields.
    let u = units != null && units !== "" ? Number(units) : null;
    let pUnit = price_per_unit != null && price_per_unit !== "" ? Number(price_per_unit) : null;
    let txCurrency = currency as string;
    let effectiveTotal = total_amount != null ? Number(total_amount) : null;
    if (effectiveTotal == null && u != null && pUnit != null) {
      effectiveTotal = u * pUnit;
    }

    // ── Derive missing position fields from the live price (market BUY) ──────
    // Two convenience entry modes, so the user need not know the share count:
    //   • amount-only  ("$5,000 in VOO")  → units  = amount / live price
    //   • units-only   ("10 shares, cost unknown") → cost = units * live price
    // Either way the position then tracks the live market like any FIFO holding.
    const amountOnly = u == null && pUnit == null && effectiveTotal != null && effectiveTotal > 0;
    const unitsOnly  = u != null && u > 0 && pUnit == null && effectiveTotal == null;
    if (isMarket && kind === "BUY" && (amountOnly || unitsOnly)) {
      const pr = await refreshPrice(db, Number(investment_id));
      if (!pr || !(pr.price > 0)) {
        return fail(res, "Couldn't fetch a live price to value this holding — enter both units and price, or try again shortly.");
      }
      pUnit = pr.price;
      if (amountOnly) {
        // Convert the entered amount into the asset's native currency if they differ (NIS/USD only).
        let amtNative = effectiveTotal as number;
        if (txCurrency !== pr.currency) {
          const rate = getRateSync(db, req.user!.id).rate; // USD→NIS
          if (txCurrency === "NIS" && pr.currency === "USD") amtNative = (effectiveTotal as number) / rate;
          else if (txCurrency === "USD" && pr.currency === "NIS") amtNative = (effectiveTotal as number) * rate;
        }
        u = amtNative / pr.price;
        effectiveTotal = amtNative;
      } else {
        // units-only: cost basis = units * live native price
        effectiveTotal = (u as number) * pr.price;
      }
      txCurrency = pr.currency;
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
      u ?? null, pUnit ?? null, effectiveTotal,
      txCurrency, wallet_id ?? null, occurred_at, notes ?? null,
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

// POST /api/transactions/bulk — insert multiple historical transactions in one shot
// Body: { investment_id: number; transactions: BulkRow[] }
// Validates, inserts all rows in a single SQLite transaction, then recomputeRealized.
transactionsRouter.post("/bulk", (req, res) => {
  try {
    const db = getDb();
    const { investment_id, transactions: rows } = req.body as {
      investment_id: number;
      transactions: Array<{
        kind: string;
        units?: number | null;
        price_per_unit?: number | null;
        total_amount?: number | null;
        currency?: string;
        occurred_at: string;
        notes?: string;
        fx_rate_at_buy?: number | null;
      }>;
    };

    if (!investment_id || !Array.isArray(rows) || rows.length === 0) {
      return fail(res, "investment_id and a non-empty transactions array are required");
    }

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(investment_id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    const isMarket = MARKET_TYPES.has(inv.type);

    // Validate all rows before touching the DB
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.kind) return fail(res, `Row ${i + 1}: kind is required`);
      if (isMarket && MANUAL_KINDS.has(row.kind)) {
        return fail(res, `Row ${i + 1}: ${inv.type} investments use BUY / SELL / DIV`);
      }
      if (!isMarket && MARKET_KINDS.has(row.kind)) {
        return fail(res, `Row ${i + 1}: ${inv.type} investments use UPDATE / DEPOSIT`);
      }
      if (!row.occurred_at) return fail(res, `Row ${i + 1}: occurred_at is required`);
      if (new Date(row.occurred_at) > new Date()) {
        return fail(res, `Row ${i + 1}: date cannot be in the future`);
      }
    }

    const insertStmt = db.prepare(
      `INSERT INTO transactions
         (investment_id, user_id, kind, units, price_per_unit, total_amount,
          currency, occurred_at, notes, fx_rate_at_buy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const runBulk = db.transaction(() => {
      for (const row of rows) {
        let total = row.total_amount != null ? Number(row.total_amount) : null;
        if (total == null && row.units != null && row.price_per_unit != null) {
          total = Number(row.units) * Number(row.price_per_unit);
        }
        if (total == null || isNaN(total)) {
          throw new Error("Each row needs total_amount or both units and price_per_unit");
        }
        insertStmt.run(
          investment_id, req.user!.id, row.kind,
          row.units ?? null, row.price_per_unit ?? null, total,
          row.currency ?? "NIS",
          row.occurred_at,
          row.notes ?? null,
          row.kind === "BUY" ? (row.fx_rate_at_buy ?? null) : null
        );
      }
    });
    runBulk();

    if (isMarket) recomputeRealized(db, Number(investment_id));
    takeSnapshot(db, req.user!.id);

    ok(res, { inserted: rows.length }, 201);
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
