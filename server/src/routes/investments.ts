import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { enrichInvestment, getUsdNisRate } from "../services/portfolio.js";

export const investmentsRouter = Router();
investmentsRouter.use(requireAuth);

const MARKET_TYPES = new Set(["crypto", "stock", "etf"]);
const MANUAL_TYPES = new Set(["pension", "education", "other"]);
const VALID_TYPES   = new Set([...MARKET_TYPES, ...MANUAL_TYPES]);

// GET /api/investments?include_closed=false
investmentsRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const includeClosed = req.query.include_closed === "true";
    const fx = getUsdNisRate(db, req.user!.id);

    const rows = db
      .prepare(
        `SELECT id, user_id, type, name, ticker, isin, broker, etf_kind,
                liquid_date, closed_at, deleted_at, created_at
         FROM investments
         WHERE user_id = ? AND deleted_at IS NULL
           ${includeClosed ? "" : "AND closed_at IS NULL"}
         ORDER BY created_at DESC`
      )
      .all(req.user!.id) as any[];

    const enriched = rows.map(inv => enrichInvestment(db, inv, fx));
    ok(res, enriched);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/investments — create investment (+ optional initial balance for manual types)
investmentsRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const {
      type, name, ticker, isin, broker, etf_kind, liquid_date,
      initial_balance, currency = "NIS", occurred_at,
    } = req.body as Record<string, unknown>;

    if (!type || !VALID_TYPES.has(type as string)) {
      return fail(res, `type must be one of: ${[...VALID_TYPES].join(", ")}`);
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return fail(res, "name is required");
    }

    const result = db.prepare(
      `INSERT INTO investments (user_id, type, name, ticker, isin, broker, etf_kind, liquid_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user!.id, type, (name as string).trim(),
      ticker ?? null, isin ?? null, broker ?? null,
      etf_kind ?? null, liquid_date ?? null
    );

    const investmentId = result.lastInsertRowid as number;

    // For manual-balance types: create first UPDATE transaction if initial_balance provided
    if (MANUAL_TYPES.has(type as string) && initial_balance != null) {
      const bal = Number(initial_balance);
      if (isNaN(bal) || bal < 0) return fail(res, "initial_balance must be a non-negative number");
      db.prepare(
        `INSERT INTO transactions
           (investment_id, user_id, kind, total_amount, currency, occurred_at, notes)
         VALUES (?, ?, 'UPDATE', ?, ?, ?, 'Initial balance')`
      ).run(
        investmentId, req.user!.id, bal,
        currency ?? "NIS",
        occurred_at ?? new Date().toISOString()
      );
    }

    const inv = db.prepare(
      `SELECT id, user_id, type, name, ticker, isin, broker, etf_kind,
              liquid_date, closed_at, deleted_at, created_at
       FROM investments WHERE id = ?`
    ).get(investmentId);

    const fx = getUsdNisRate(db, req.user!.id);
    ok(res, enrichInvestment(db, inv as any, fx), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/investments/:id — edit metadata only
investmentsRouter.patch("/:id", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id);
    if (!inv) return fail(res, "Investment not found", 404);

    const allowed = ["name", "ticker", "isin", "broker", "etf_kind", "liquid_date"];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (key in req.body) {
        updates.push(`${key} = ?`);
        values.push(req.body[key] ?? null);
      }
    }
    if (updates.length === 0) return fail(res, "No valid fields to update");

    values.push(id);
    db.prepare(`UPDATE investments SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare(
      `SELECT id, user_id, type, name, ticker, isin, broker, etf_kind,
              liquid_date, closed_at, deleted_at, created_at
       FROM investments WHERE id = ?`
    ).get(id);

    const fx = getUsdNisRate(db, req.user!.id);
    ok(res, enrichInvestment(db, updated as any, fx));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/investments/check-existing?ticker=BTC&type=crypto
investmentsRouter.get("/check-existing", (req, res) => {
  try {
    const db = getDb();
    const { ticker, type } = req.query as { ticker?: string; type?: string };
    if (!ticker || !type) return fail(res, "ticker and type are required");

    const existing = db.prepare(
      `SELECT id, name, ticker, type, broker, created_at FROM investments
       WHERE user_id = ? AND ticker = ? AND type = ?
         AND deleted_at IS NULL AND closed_at IS NULL`
    ).get(req.user!.id, ticker.toUpperCase(), type) as Record<string,unknown> | undefined;

    if (!existing) return ok(res, null);

    // Get position summary
    const fx = getUsdNisRate(db, req.user!.id);
    const enriched = enrichInvestment(db, existing as any, fx);
    ok(res, {
      id: existing.id,
      name: existing.name,
      ticker: existing.ticker,
      type: existing.type,
      broker: existing.broker,
      remaining_units: enriched.remaining_units,
      current_value_nis: enriched.current_value_nis,
      unrealized_pl_nis: enriched.unrealized_pl_nis,
    });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/investments/:id/tx-count — used by delete confirmation
investmentsRouter.get("/:id/tx-count", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const inv = db.prepare(
      "SELECT id, name FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id) as { id: number; name: string } | undefined;
    if (!inv) return fail(res, "Investment not found", 404);

    const { tx_count } = db.prepare(
      "SELECT COUNT(*) as tx_count FROM transactions WHERE investment_id = ?"
    ).get(id) as { tx_count: number };

    const { realized_count } = db.prepare(
      "SELECT COUNT(*) as realized_count FROM transactions WHERE investment_id = ? AND kind = 'SELL' AND realized_pl IS NOT NULL"
    ).get(id) as { realized_count: number };

    ok(res, { id, name: inv.name, tx_count, realized_count });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/investments/:id/update-balance — quick UPDATE transaction for pension/education/other
investmentsRouter.post("/:id/update-balance", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    if (!MANUAL_TYPES.has(inv.type)) {
      return fail(res, "update-balance is only for pension / education / other");
    }

    const { balance, currency = "NIS", occurred_at, notes } = req.body as Record<string,unknown>;
    const bal = Number(balance);
    if (isNaN(bal) || bal < 0) return fail(res, "balance must be a non-negative number");

    const result = db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at, notes)
       VALUES (?, ?, 'UPDATE', ?, ?, ?, ?)`
    ).run(
      id, req.user!.id, bal, currency,
      occurred_at ?? new Date().toISOString(),
      notes ?? null
    );

    ok(res, { transaction_id: result.lastInsertRowid }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/investments/:id — soft delete
investmentsRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const inv = db.prepare(
      "SELECT id FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id);
    if (!inv) return fail(res, "Investment not found", 404);

    db.prepare(
      "UPDATE investments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
    ).run(id);
    ok(res, { id });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
