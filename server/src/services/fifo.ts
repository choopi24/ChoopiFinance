/**
 * FIFO cost-basis engine for Crypto / Stock / ETF investments.
 *
 * Assumptions:
 *  - All BUY and SELL transactions for one investment share the same currency.
 *    If they don't, pass fx_rate_at_buy on each BUY to normalise to NIS.
 *  - "Units" means shares, coins, or ETF units — always positive numbers.
 *  - Floating-point comparison uses a 1e-10 epsilon guard (sub-satoshi noise).
 *
 * This file has no Express dependency and is pure business logic so it can be
 * imported directly by vitest tests with no extra mocking.
 */

import type Database from "better-sqlite3";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FifoLot {
  tx_id: number;
  units_remaining: number;
  price_per_unit: number;
  currency: string;
  occurred_at: string;
}

export interface PositionResult {
  remaining_units: number;
  cost_basis_remaining: number; // sum(units_remaining * price_per_unit) native
  realized_pl_total: number;    // sum of all SELL realized P/Ls
  currency: string;
  lots: FifoLot[];              // surviving BUY lots
  is_closed: boolean;           // remaining_units < epsilon
}

export interface RealizationDetail {
  sell_tx_id: number;
  realized_pl: number;
  currency: string;
}

interface TxRow {
  id: number;
  kind: string;
  units: number | null;
  price_per_unit: number | null;
  total_amount: number;
  currency: string;
  occurred_at: string;
}

const EPSILON = 1e-10;

// ── Core algorithm (operates on raw transaction rows) ─────────────────────────

function runFifo(txs: TxRow[]): {
  lots: FifoLot[];
  realized: { sell_tx_id: number; realized_pl: number; currency: string }[];
  currency: string;
} {
  const lots: FifoLot[] = [];
  const realized: { sell_tx_id: number; realized_pl: number; currency: string }[] = [];
  let currency = "NIS";

  for (const tx of txs) {
    if (tx.kind === "BUY" && tx.units != null && tx.price_per_unit != null && tx.units > 0) {
      currency = tx.currency;
      lots.push({
        tx_id: tx.id,
        units_remaining: tx.units,
        price_per_unit: tx.price_per_unit,
        currency: tx.currency,
        occurred_at: tx.occurred_at,
      });
    } else if (tx.kind === "SELL" && tx.units != null && tx.units > 0) {
      currency = tx.currency;
      const sellPrice =
        tx.price_per_unit != null ? tx.price_per_unit : tx.total_amount / tx.units;
      let unitsToSell = tx.units;
      let realizedThisSell = 0;

      while (unitsToSell > EPSILON && lots.length > 0) {
        const lot = lots[0];
        const deduct = Math.min(lot.units_remaining, unitsToSell);
        realizedThisSell += deduct * (sellPrice - lot.price_per_unit);
        lot.units_remaining -= deduct;
        unitsToSell -= deduct;
        if (lot.units_remaining < EPSILON) lots.shift();
      }

      realized.push({ sell_tx_id: tx.id, realized_pl: realizedThisSell, currency: tx.currency });
    }
    // DIV and UPDATE are ignored by FIFO — they don't affect lot queue
  }

  return { lots, realized, currency };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Read-only position snapshot. Does NOT write to the DB.
 * Use when you only need the derived numbers (e.g. for GET /api/investments).
 */
export function computePosition(db: Database.Database, investmentId: number): PositionResult {
  const txs = db
    .prepare<[number], TxRow>(
      `SELECT id, kind, units, price_per_unit, total_amount, currency, occurred_at
       FROM transactions
       WHERE investment_id = ? AND kind IN ('BUY','SELL')
       ORDER BY occurred_at ASC, id ASC`
    )
    .all(investmentId);

  const { lots, realized, currency } = runFifo(txs);

  const remaining_units = lots.reduce((s, l) => s + l.units_remaining, 0);
  const cost_basis_remaining = lots.reduce(
    (s, l) => s + l.units_remaining * l.price_per_unit,
    0
  );
  const realized_pl_total = realized.reduce((s, r) => s + r.realized_pl, 0);

  return {
    remaining_units,
    cost_basis_remaining,
    realized_pl_total,
    currency,
    lots,
    is_closed: remaining_units < EPSILON,
  };
}

/**
 * Recompute realized_pl for every SELL in this investment, then persist to DB.
 * Call after any BUY / SELL create, edit, or delete to keep numbers consistent.
 * Returns per-SELL details so callers can update closed_at on the investment.
 */
export function recomputeRealized(
  db: Database.Database,
  investmentId: number
): RealizationDetail[] {
  const txs = db
    .prepare<[number], TxRow>(
      `SELECT id, kind, units, price_per_unit, total_amount, currency, occurred_at
       FROM transactions
       WHERE investment_id = ? AND kind IN ('BUY','SELL')
       ORDER BY occurred_at ASC, id ASC`
    )
    .all(investmentId);

  const { lots, realized } = runFifo(txs);

  const updateStmt = db.prepare(
    "UPDATE transactions SET realized_pl = ? WHERE id = ?"
  );

  const recomputeTx = db.transaction(() => {
    for (const r of realized) {
      updateStmt.run(r.realized_pl, r.sell_tx_id);
    }
  });
  recomputeTx();

  // Return remaining units so caller can set/clear closed_at
  const remaining = lots.reduce((s, l) => s + l.units_remaining, 0);
  const isClosed = remaining < EPSILON;

  db.prepare(
    `UPDATE investments SET closed_at = ? WHERE id = ?`
  ).run(
    isClosed ? new Date().toISOString() : null,
    investmentId
  );

  return realized;
}

// ── Pension / Education / Other helpers ───────────────────────────────────────

interface UpdateRow {
  id: number;
  total_amount: number;
  currency: string;
  occurred_at: string;
}

/**
 * For non-market investments (pension / education / other):
 * current value = latest UPDATE transaction total_amount.
 * "Unrealized P/L" = latest_total - first_total (growth from initial balance).
 * Net deposited = 0 (balance changes are NOT deposits).
 */
export function computeManualPosition(
  db: Database.Database,
  investmentId: number
): {
  current_value: number;
  unrealized_pl: number;
  currency: string;
  last_update_at: string | null;
  update_count: number;
} {
  const updates = db
    .prepare<[number], UpdateRow>(
      `SELECT id, total_amount, currency, occurred_at
       FROM transactions
       WHERE investment_id = ? AND kind = 'UPDATE'
       ORDER BY occurred_at ASC, id ASC`
    )
    .all(investmentId);

  if (updates.length === 0) {
    return { current_value: 0, unrealized_pl: 0, currency: "NIS", last_update_at: null, update_count: 0 };
  }

  const first = updates[0];
  const last = updates[updates.length - 1];
  return {
    current_value: last.total_amount,
    unrealized_pl: last.total_amount - first.total_amount,
    currency: last.currency,
    last_update_at: last.occurred_at,
    update_count: updates.length,
  };
}
