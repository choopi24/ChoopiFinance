import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { enrichInvestment, getUsdNisRate } from "../services/portfolio.js";
import { recomputeRealized } from "../services/fifo.js";
import { toNis } from "../services/fx.js";
import {
  validateExpectedAnnualReturn,
  validateMonthlyContribution,
  isError,
} from "./projectionValidation.js";
import { validateInvestmentPatchValue } from "./editValidation.js";

export const investmentsRouter = Router();
investmentsRouter.use(requireAuth);

const MARKET_TYPES = new Set(["crypto", "stock", "etf", "rsu"]);
const MANUAL_TYPES = new Set(["pension", "gemel", "education", "money_market", "other"]);
// RSU investments are created through /api/rsu (grant + schedule), not this generic route.
const VALID_TYPES   = new Set([...MARKET_TYPES, ...MANUAL_TYPES].filter(t => t !== "rsu"));

// ── Shared SELECT for enrichment ─────────────────────────────────────────────

const INV_SELECT = `
  SELECT id, user_id, type, name, ticker, isin, broker, etf_kind,
         liquid_date, closed_at, deleted_at, monthly_deposit, deposit_currency,
         expected_annual_return, monthly_contribution,
         fund_id, fund_track, fee_deposit_pct, fee_balance_pct, created_at
  FROM investments
`;

/** Normalise ticker: trim + uppercase, return null for empty strings. */
function normaliseTicker(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  return s || null;
}

// GET /api/investments?include_closed=false
investmentsRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const includeClosed = req.query.include_closed === "true";
    const fx = getUsdNisRate(db, req.user!.id);

    const rows = db
      .prepare(
        `${INV_SELECT}
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
      monthly_deposit, deposit_currency = "NIS",
      fund_id, fund_track, fee_deposit_pct, fee_balance_pct,
      holding,
    } = req.body as Record<string, unknown>;

    if (!type || !VALID_TYPES.has(type as string)) {
      return fail(res, `type must be one of: ${[...VALID_TYPES].join(", ")}`);
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return fail(res, "name is required");
    }

    // FIX 1: normalise ticker to UPPERCASE on insert
    const tickerNorm = normaliseTicker(ticker);

    const numOrNull = (v: unknown) =>
      v != null && v !== "" && !isNaN(Number(v)) ? Number(v) : null;

    const result = db.prepare(
      `INSERT INTO investments
         (user_id, type, name, ticker, isin, broker, etf_kind, liquid_date,
          monthly_deposit, deposit_currency,
          fund_id, fund_track, fee_deposit_pct, fee_balance_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user!.id, type, (name as string).trim(),
      tickerNorm,
      isin ?? null, broker ?? null,
      etf_kind ?? null, liquid_date ?? null,
      numOrNull(monthly_deposit),
      deposit_currency ?? "NIS",
      numOrNull(fund_id),
      (typeof fund_track === "string" && fund_track.trim()) ? fund_track.trim() : null,
      numOrNull(fee_deposit_pct),
      numOrNull(fee_balance_pct)
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

    // For market types: create a synthetic BUY if the caller supplied a holding object.
    // This keeps the FIFO engine consistent — the investment and its initial lot
    // are written atomically in the same request.
    if (MARKET_TYPES.has(type as string) && holding != null) {
      const h = holding as Record<string, unknown>;
      const hUnits = Number(h.units);
      const hPrice = Number(h.avg_price ?? 0);
      const hCcy   = String(h.currency ?? "USD");
      const hDate  = String(h.as_of ?? new Date().toISOString());

      if (isNaN(hUnits) || hUnits <= 0) return fail(res, "holding.units must be a positive number");
      if (isNaN(hPrice) || hPrice < 0)  return fail(res, "holding.avg_price must be non-negative");
      if (new Date(hDate) > new Date())  return fail(res, "holding.as_of cannot be in the future");

      db.prepare(
        `INSERT INTO transactions
           (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at, notes)
         VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, 'Initial holding (synthetic)')`
      ).run(investmentId, req.user!.id, hUnits, hPrice, hUnits * hPrice, hCcy, hDate);

      recomputeRealized(db, investmentId);
    }

    const inv = db.prepare(`${INV_SELECT} WHERE id = ?`).get(investmentId);
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

    const allowed = ["name", "ticker", "isin", "broker", "etf_kind", "liquid_date",
                     "monthly_deposit", "deposit_currency",
                     "expected_annual_return", "monthly_contribution",
                     "fund_id", "fund_track", "fee_deposit_pct", "fee_balance_pct"];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (!(key in req.body)) continue;
      if (key === "ticker") {
        // FIX 1: normalise ticker to UPPERCASE on patch
        updates.push("ticker = ?");
        values.push(normaliseTicker(req.body[key]));
      } else if (key === "monthly_deposit" || key === "fund_id" ||
                 key === "fee_deposit_pct" || key === "fee_balance_pct") {
        updates.push(`${key} = ?`);
        const v = req.body[key];
        values.push(v != null && v !== "" ? Number(v) : null);
      } else if (key === "expected_annual_return") {
        const r = validateExpectedAnnualReturn(req.body[key]);
        if (isError(r)) return fail(res, r.error);
        updates.push("expected_annual_return = ?");
        values.push(r.value);
      } else if (key === "monthly_contribution") {
        const r = validateMonthlyContribution(req.body[key]);
        if (isError(r)) return fail(res, r.error);
        updates.push("monthly_contribution = ?");
        values.push(r.value);
      } else {
        // name / etf_kind / liquid_date / deposit_currency / broker / isin / fund_track:
        // validate + normalize instead of surfacing SQLite CHECK failures as 500s.
        const r = validateInvestmentPatchValue(key, req.body[key]);
        if ("error" in r) return fail(res, r.error);
        updates.push(`${key} = ?`);
        values.push(r.value);
      }
    }
    if (updates.length === 0) return fail(res, "No valid fields to update");

    values.push(id);
    db.prepare(`UPDATE investments SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    const updated = db.prepare(`${INV_SELECT} WHERE id = ?`).get(id);
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
      `${INV_SELECT}
       WHERE user_id = ? AND ticker = ? AND type = ?
         AND deleted_at IS NULL AND closed_at IS NULL`
    ).get(req.user!.id, ticker.toUpperCase(), type) as Record<string,unknown> | undefined;

    if (!existing) return ok(res, null);

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

// GET /api/investments/:id/history — value-over-time series (NIS) reconstructed from transactions.
//   Market types: mark-to-market at each BUY/SELL using that tx's price, plus today's live value.
//   Manual types: each UPDATE snapshot is a real balance reading over time.
investmentsRouter.get("/:id/history", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    const fx = getUsdNisRate(db, req.user!.id);
    const points: { t: string; value_nis: number }[] = [];

    if (MARKET_TYPES.has(inv.type)) {
      const txs = db.prepare(
        `SELECT kind, units, price_per_unit, total_amount, currency, occurred_at
         FROM transactions
         WHERE investment_id = ? AND kind IN ('BUY','SELL')
         ORDER BY occurred_at ASC, id ASC`
      ).all(id) as Array<{
        kind: string; units: number | null; price_per_unit: number | null;
        total_amount: number; currency: string; occurred_at: string;
      }>;

      let cumUnits = 0;
      let costOnly = 0; // amount-only BUYs (unpriceable tickers) held at cost
      for (const tx of txs) {
        if (tx.kind === "BUY") {
          if (tx.units != null && tx.price_per_unit != null && tx.units > 0) cumUnits += tx.units;
          else costOnly += tx.total_amount;
        } else if (tx.kind === "SELL" && tx.units != null) {
          cumUnits = Math.max(0, cumUnits - tx.units);
        }
        const price = tx.price_per_unit != null
          ? tx.price_per_unit
          : (tx.units ? tx.total_amount / tx.units : 0);
        const valueNative = cumUnits * price + costOnly;
        points.push({ t: tx.occurred_at, value_nis: toNis(valueNative, tx.currency, fx.rate) });
      }

      // Append today's live value as the final point.
      const enriched = enrichInvestment(db, inv, fx);
      points.push({
        t: enriched.price_cached_at ?? new Date().toISOString(),
        value_nis: enriched.current_value_nis,
      });
    } else {
      const updates = db.prepare(
        `SELECT total_amount, currency, occurred_at
         FROM transactions
         WHERE investment_id = ? AND kind = 'UPDATE'
         ORDER BY occurred_at ASC, id ASC`
      ).all(id) as Array<{ total_amount: number; currency: string; occurred_at: string }>;
      for (const u of updates) {
        points.push({ t: u.occurred_at, value_nis: toNis(u.total_amount, u.currency, fx.rate) });
      }
    }

    // Collapse to one point per calendar day (keep the last reading of each day), ascending.
    const byDay = new Map<string, { t: string; value_nis: number }>();
    for (const p of points) byDay.set(p.t.slice(0, 10), p);
    const series = [...byDay.values()].sort((a, b) => a.t.localeCompare(b.t));

    ok(res, { id, type: inv.type, points: series });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/investments/:id/update-balance — quick UPDATE snapshot for pension/education/other
investmentsRouter.post("/:id/update-balance", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    if (!MANUAL_TYPES.has(inv.type)) {
      return fail(res, "update-balance is only for manual fund types");
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

// POST /api/investments/:id/contribute — add a cash contribution to an education/other fund.
// Atomically records a DEPOSIT (raises net-deposited) AND an UPDATE balance snapshot bumped
// by the same amount, so the contribution itself never shows up as profit:
//   P/L = current_value − net_deposited, and both rise by `amount` → P/L unchanged.
investmentsRouter.post("/:id/contribute", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    if (inv.type === "pension" || !MANUAL_TYPES.has(inv.type)) {
      return fail(
        res,
        inv.type === "pension"
          ? "Pension funds track contributions via the monthly deposit setting, not one-off contributions."
          : "Contributions apply to manual funds. For crypto / stocks / ETFs, record a Buy."
      );
    }

    const { amount, currency, occurred_at, notes } = req.body as Record<string, unknown>;
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return fail(res, "amount must be a positive number");

    // The fund's working currency + last recorded balance come from the latest UPDATE snapshot.
    const lastUpdate = db.prepare(
      `SELECT total_amount, currency, occurred_at FROM transactions
       WHERE investment_id = ? AND kind = 'UPDATE'
       ORDER BY occurred_at DESC, id DESC LIMIT 1`
    ).get(id) as { total_amount: number; currency: string; occurred_at: string } | undefined;

    // Keep everything in one currency (no FX mixing): reuse the fund's currency when it exists.
    const ccy = lastUpdate?.currency ?? (typeof currency === "string" ? currency : "NIS");
    const prevBalance = lastUpdate?.total_amount ?? 0;
    const nowIso = new Date().toISOString();
    // DEPOSIT keeps the user-chosen date (record of when the money went in).
    const when = (typeof occurred_at === "string" && occurred_at) ? occurred_at : nowIso;
    const note = (typeof notes === "string" && notes.trim()) ? notes.trim() : null;

    // The balance-after-contribution UPDATE must be the latest snapshot so it becomes the
    // current value. ISO timestamps sort chronologically, so take the max of (deposit date,
    // now, last snapshot) — guarding against a back-dated contribution leaving value stale.
    const updateWhen = [when, nowIso, lastUpdate?.occurred_at]
      .filter(Boolean).sort().at(-1) as string;

    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at, notes)
         VALUES (?, ?, 'DEPOSIT', ?, ?, ?, ?)`
      ).run(id, req.user!.id, amt, ccy, when, note ?? "Contribution");
      db.prepare(
        `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at, notes)
         VALUES (?, ?, 'UPDATE', ?, ?, ?, ?)`
      ).run(id, req.user!.id, prevBalance + amt, ccy, updateWhen, "Balance after contribution");
    });
    run();

    ok(res, { id, amount: amt, currency: ccy, new_balance: prevBalance + amt }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/investments/:id/log-deposit — record a cash deposit for education/other P/L tracking
investmentsRouter.post("/:id/log-deposit", (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);

    const inv = db.prepare(
      "SELECT * FROM investments WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    ).get(id, req.user!.id) as any;
    if (!inv) return fail(res, "Investment not found", 404);

    if (inv.type === "pension") {
      return fail(res, "Pension funds use monthly_deposit for contribution tracking, not DEPOSIT transactions");
    }
    if (!MANUAL_TYPES.has(inv.type)) {
      return fail(res, "log-deposit is only for manual fund types");
    }

    const { amount, currency = "NIS", occurred_at, notes } = req.body as Record<string,unknown>;
    const amt = Number(amount);
    if (isNaN(amt) || amt <= 0) return fail(res, "amount must be a positive number");

    const result = db.prepare(
      `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at, notes)
       VALUES (?, ?, 'DEPOSIT', ?, ?, ?, ?)`
    ).run(
      id, req.user!.id, amt, currency,
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
