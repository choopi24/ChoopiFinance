/**
 * Portfolio aggregation service.
 * Converts all investment positions into a unified NIS-denominated summary.
 *
 * FX policy:
 *  - Uses fx_cache table (pair = 'USD_NIS') for conversion.
 *  - Falls back to FALLBACK_USD_NIS if the cache is empty.
 *    Clients see "rate_source: cached|fallback" in the response.
 *  - Cost basis for SELL uses fx_rate_at_buy stored on the BUY transactions.
 *    If that column is NULL, falls back to the current display rate.
 *
 * Stale detection (non-market investments only):
 *  - stale_days ≥ 30 → stale_level = "stale-30"
 *  - stale_days ≥ 60 → stale_level = "stale-60"
 */

import type Database from "better-sqlite3";
import { computePosition, computeManualPosition } from "./fifo.js";
import { getRateSync, toNis } from "./fx.js";
import { datasetForType, estimateFromCache } from "./israelFunds.js";

const MARKET_TYPES = new Set(["crypto", "stock", "etf"]);
const STALE_30 = 30;
const STALE_60 = 60;

// ── FX helpers ────────────────────────────────────────────────────────────────

export interface FxInfo {
  rate: number;
  source: "cached" | "fallback" | "override";
}

/** Synchronous FX lookup — reads cache only. Delegates to fx service. */
export function getUsdNisRate(db: Database.Database, userId?: number): FxInfo {
  return getRateSync(db, userId);
}

// ── Investment row type (from DB) ─────────────────────────────────────────────

interface InvRow {
  id: number;
  user_id: number;
  type: string;
  name: string;
  ticker: string | null;
  isin: string | null;
  broker: string | null;
  etf_kind: string | null;
  liquid_date: string | null;
  closed_at: string | null;
  deleted_at: string | null;
  monthly_deposit: number | null;
  deposit_currency: string;
  expected_annual_return: number | null;
  monthly_contribution: number | null;
  fund_id: number | null;
  fund_track: string | null;
  fee_deposit_pct: number | null;
  fee_balance_pct: number | null;
  created_at: string;
}

// ── Enriched investment (returned by routes) ──────────────────────────────────

export interface EnrichedInvestment {
  id: number;
  user_id: number;
  type: string;
  name: string;
  ticker: string | null;
  isin: string | null;
  broker: string | null;
  etf_kind: string | null;
  liquid_date: string | null;
  closed_at: string | null;
  created_at: string;
  monthly_deposit: number | null;
  deposit_currency: string;
  expected_annual_return: number | null;
  monthly_contribution: number | null;
  fund_id: number | null;
  fund_track: string | null;
  fee_deposit_pct: number | null;
  fee_balance_pct: number | null;

  // Position
  remaining_units: number;
  /**
   * For market types: FIFO cost basis of remaining lots.
   * For manual types: net amount deposited (monthly_deposit model or DEPOSIT sum).
   * Used for portfolio total_net_deposited_nis.
   */
  cost_basis_nis: number;
  /** Alias of cost_basis_nis surfaced explicitly for the client. */
  net_deposited_nis: number;
  current_value_nis: number;
  current_price: number | null;
  current_price_currency: string | null;
  price_cached_at: string | null;
  unrealized_pl_nis: number;
  unrealized_pct: number | null;
  realized_pl_nis: number;
  currency: string;

  // Stale (non-market only)
  last_update_at: string | null;
  stale_days: number | null;
  stale_level: "stale-30" | "stale-60" | null;
  update_count: number;

  // Israeli fund estimate (Gemel-Net/Pensia-Net published yields)
  /** True when current_value_nis was grown forward from the last manual balance. */
  value_estimated: boolean;
  /** The last manually-entered balance in NIS (estimate baseline). */
  last_reported_balance_nis: number | null;

  // FX metadata for tooltip
  fx_rate_used: number;
  fx_source: "cached" | "fallback" | "override";
}

interface PriceRow {
  price: number;
  currency: string;
  fetched_at: string;
}

function staleMeta(lastUpdateAt: string | null): {
  stale_days: number | null;
  stale_level: "stale-30" | "stale-60" | null;
} {
  if (!lastUpdateAt) return { stale_days: null, stale_level: null };
  const days = Math.floor(
    (Date.now() - new Date(lastUpdateAt).getTime()) / 86_400_000
  );
  return {
    stale_days: days,
    stale_level: days >= STALE_60 ? "stale-60" : days >= STALE_30 ? "stale-30" : null,
  };
}

// ── Main enrichment function ──────────────────────────────────────────────────

export function enrichInvestment(
  db: Database.Database,
  inv: InvRow,
  fx: FxInfo
): EnrichedInvestment {
  const isMarket = MARKET_TYPES.has(inv.type);

  if (isMarket) {
    const pos = computePosition(db, inv.id);

    // Defensive UPPERCASE before price_cache lookup (FIX 1: ticker casing)
    const symbol = (inv.ticker ?? "").toUpperCase();
    const priceRow = symbol
      ? (db
          .prepare<[string, string], PriceRow>(
            "SELECT price, currency, fetched_at FROM price_cache WHERE symbol = ? AND asset_type = ?"
          )
          .get(symbol, inv.type) as PriceRow | undefined)
      : undefined;

    const current_price = priceRow?.price ?? null;
    const priceCurrency = priceRow?.currency ?? pos.currency;
    const current_value_native = current_price != null
      ? pos.remaining_units * current_price
      : null;
    // Live-priced units (if any) PLUS any cost-only amount valued at cost.
    // With no price at all, fall back to the full cost basis (incl. cost-only),
    // so an amount-only holding for an unpriceable ticker still shows its value.
    const current_value_nis = current_value_native != null
      ? toNis(current_value_native, priceCurrency, fx.rate) + toNis(pos.cost_only_value, pos.currency, fx.rate)
      : toNis(pos.cost_basis_remaining, pos.currency, fx.rate);

    const cost_basis_nis = toNis(pos.cost_basis_remaining, pos.currency, fx.rate);
    const realized_pl_nis = toNis(pos.realized_pl_total, pos.currency, fx.rate);

    // Only show unrealized P&L once we have a price fetched AFTER the position was
    // established — otherwise the entry-flow price (≈ the BUY price) produces a
    // phantom gain/loss that's really just cost basis. We compare against the most
    // recent BUY's created_at (when it was actually recorded). occurred_at can't be
    // used: it's stored at midnight, so any same-day price would look "post-entry".
    // Compare at SECOND granularity: created_at is second-precision (strftime), while
    // price fetched_at carries milliseconds — so a price cached during the same-second
    // add flow must NOT count as post-entry.
    const lastBuy = db
      .prepare<[number], { last_buy: string | null }>(
        "SELECT MAX(created_at) AS last_buy FROM transactions WHERE investment_id = ? AND kind = 'BUY'"
      )
      .get(inv.id) as { last_buy: string | null } | undefined;
    const lastBuyAt = lastBuy?.last_buy ?? null;
    const toSec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    const pricePostEntry =
      priceRow != null &&
      lastBuyAt != null &&
      toSec(priceRow.fetched_at) > toSec(lastBuyAt);

    const unrealized_pl_nis = pricePostEntry ? current_value_nis - cost_basis_nis : 0;
    const unrealized_pct =
      pricePostEntry && cost_basis_nis > 0 ? (unrealized_pl_nis / cost_basis_nis) * 100 : null;

    return {
      ...inv,
      remaining_units: pos.remaining_units,
      cost_basis_nis,
      net_deposited_nis: cost_basis_nis,
      current_value_nis,
      current_price,
      current_price_currency: priceCurrency,
      price_cached_at: priceRow?.fetched_at ?? null,
      unrealized_pl_nis,
      unrealized_pct,
      realized_pl_nis,
      currency: pos.currency,
      last_update_at: null,
      stale_days: null,
      stale_level: null,
      update_count: 0,
      value_estimated: false,
      last_reported_balance_nis: null,
      fx_rate_used: fx.rate,
      fx_source: fx.source,
    };
  } else {
    // Manual types (pension / gemel / education / money_market / other)
    const man = computeManualPosition(db, inv.id, {
      type: inv.type,
      monthly_deposit: inv.monthly_deposit,
    });

    // Israeli regulated funds: grow the last manual balance forward using the
    // regulator's published monthly track yields + contributions − fees.
    let current_value_native = man.current_value;
    let value_estimated = false;
    const dataset = datasetForType(inv.type);
    if (dataset && inv.fund_id != null && man.last_update_at != null) {
      const est = estimateFromCache(
        db, dataset, inv.fund_id,
        man.current_value, man.last_update_at,
        inv.monthly_deposit, inv.fee_deposit_pct, inv.fee_balance_pct
      );
      if (est) {
        current_value_native = est.value;
        value_estimated = true;
      }
    }

    const current_value_nis = toNis(current_value_native, man.currency, fx.rate);
    // cost_basis = net deposited, converted to NIS
    const cost_basis_nis = toNis(man.net_deposited, man.currency, fx.rate);
    const unrealized_pl_nis = current_value_nis - cost_basis_nis;
    const unrealized_pct =
      cost_basis_nis > 0 ? (unrealized_pl_nis / cost_basis_nis) * 100 : null;
    const { stale_days, stale_level } = staleMeta(man.last_update_at);

    return {
      ...inv,
      remaining_units: 0,
      cost_basis_nis,
      net_deposited_nis: cost_basis_nis,
      current_value_nis,
      current_price: null,
      current_price_currency: null,
      price_cached_at: null,
      unrealized_pl_nis,
      unrealized_pct,
      realized_pl_nis: 0,
      currency: man.currency,
      last_update_at: man.last_update_at,
      stale_days,
      stale_level,
      update_count: man.update_count,
      value_estimated,
      last_reported_balance_nis: value_estimated
        ? toNis(man.current_value, man.currency, fx.rate)
        : null,
      fx_rate_used: fx.rate,
      fx_source: fx.source,
    };
  }
}

// ── Portfolio summary ─────────────────────────────────────────────────────────

export interface AllocationSlice {
  label: string;
  value_nis: number;
  pct: number;
}

export interface PortfolioSummary {
  total_value_nis: number;
  total_net_deposited_nis: number;
  unrealized_pl_nis: number;
  unrealized_pct: number | null;
  realized_ytd_nis: number;
  dividends_ytd_nis: number;
  allocation_by_type: AllocationSlice[];
  allocation_by_currency: AllocationSlice[];
  fx_rate_used: number;
  fx_source: "cached" | "fallback" | "override";
  investment_count: number;
}

export function computePortfolio(
  db: Database.Database,
  userId: number
): PortfolioSummary {
  const fx = getUsdNisRate(db, userId);

  const investments = db
    .prepare<[number], InvRow>(
      `SELECT id, user_id, type, name, ticker, isin, broker, etf_kind, liquid_date,
              closed_at, deleted_at, monthly_deposit, deposit_currency,
              expected_annual_return, monthly_contribution,
              fund_id, fund_track, fee_deposit_pct, fee_balance_pct, created_at
       FROM investments
       WHERE user_id = ? AND deleted_at IS NULL AND closed_at IS NULL`
    )
    .all(userId);

  const enriched = investments.map(inv => enrichInvestment(db, inv, fx));

  const total_value_nis = enriched.reduce((s, e) => s + e.current_value_nis, 0);
  const total_net_deposited_nis = enriched.reduce((s, e) => s + e.cost_basis_nis, 0);
  // Sum the per-investment unrealized P&L (which is gated to post-entry prices)
  // rather than recomputing total_value − cost — otherwise a freshly-added
  // position would leak its entry-time phantom gain into the portfolio total.
  const unrealized_pl_nis = enriched.reduce((s, e) => s + e.unrealized_pl_nis, 0);
  const unrealized_pct =
    total_net_deposited_nis > 0
      ? (unrealized_pl_nis / total_net_deposited_nis) * 100
      : null;

  // ── Realized & dividends YTD — per-row currency conversion ──────────────────
  // Each row is converted to NIS via toNis() using its own currency and the
  // current fx rate before summing (mixes NIS + USD rows safely).
  const yearStart = `${new Date().getFullYear()}-01-01T00:00:00Z`;

  const sellRows = db
    .prepare<[number, string], { realized_pl: number | null; currency: string }>(
      `SELECT realized_pl, currency
       FROM transactions
       WHERE user_id = ? AND kind = 'SELL' AND occurred_at >= ?`
    )
    .all(userId, yearStart);

  let realized_ytd_nis = 0;
  for (const r of sellRows) {
    if (r.realized_pl == null) continue;
    realized_ytd_nis += toNis(r.realized_pl, r.currency, fx.rate);
  }

  const divRows = db
    .prepare<[number, string], { total_amount: number; currency: string }>(
      `SELECT total_amount, currency
       FROM transactions
       WHERE user_id = ? AND kind = 'DIV' AND occurred_at >= ?`
    )
    .all(userId, yearStart);

  let dividends_ytd_nis = 0;
  for (const r of divRows) {
    dividends_ytd_nis += toNis(r.total_amount, r.currency, fx.rate);
  }

  // Allocation by type
  const byType = new Map<string, number>();
  for (const e of enriched) {
    byType.set(e.type, (byType.get(e.type) ?? 0) + e.current_value_nis);
  }
  const allocation_by_type: AllocationSlice[] = [...byType.entries()]
    .map(([label, value_nis]) => ({
      label,
      value_nis,
      pct: total_value_nis > 0 ? (value_nis / total_value_nis) * 100 : 0,
    }))
    .sort((a, b) => b.value_nis - a.value_nis);

  // Allocation by currency
  const byCcy = new Map<string, number>();
  for (const e of enriched) {
    byCcy.set(e.currency, (byCcy.get(e.currency) ?? 0) + e.current_value_nis);
  }
  const allocation_by_currency: AllocationSlice[] = [...byCcy.entries()]
    .map(([label, value_nis]) => ({
      label,
      value_nis,
      pct: total_value_nis > 0 ? (value_nis / total_value_nis) * 100 : 0,
    }))
    .sort((a, b) => b.value_nis - a.value_nis);

  return {
    total_value_nis,
    total_net_deposited_nis,
    unrealized_pl_nis,
    unrealized_pct,
    realized_ytd_nis,
    dividends_ytd_nis,
    allocation_by_type,
    allocation_by_currency,
    fx_rate_used: fx.rate,
    fx_source: fx.source,
    investment_count: enriched.length,
  };
}
