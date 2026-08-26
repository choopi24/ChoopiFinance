/**
 * Valuation + the core decomposition.
 *
 * For every account, at any date t, this service answers the question the app
 * exists to answer:
 *
 *     value(t) = principal(t) + gross_earnings(t) − fees(t)
 *  ⟹ gross_earnings(t) = value(t) − principal(t) + fees(t)
 *
 *   principal — MY money: what I put in and haven't taken out
 *   earnings  — growth/interest, GROSS of management fees
 *   fees      — what management fees have eaten
 *
 * Why fees are added back to get earnings: a statement balance already has fees
 * deducted. Recording a fee therefore does not change your net worth — it moves
 * the gap out of "earnings" and into "fees" so the drag becomes visible. With no
 * fee rows at all, fees hide inside earnings and both numbers are understated.
 *
 * Nothing here reaches the network. Prices and FX come from the dated manual
 * series (price_points / fx_rates), newest row on-or-before t carried forward.
 */

import type Database from "better-sqlite3";
import { fifoPosition, type LotEvent } from "./fifo.js";

export type Currency = "ILS" | "USD";
export type ValuationMode = "market" | "balance";

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Dated lookups (carry-forward) ─────────────────────────────────────────────

export interface PriceLookup {
  price: number;
  currency: Currency;
  as_of: string;
}

/** Newest manually-entered price for `symbol` dated on-or-before `date`. */
export function priceOnOrBefore(
  db: Database.Database,
  userId: number,
  symbol: string,
  date: string
): PriceLookup | null {
  const row = db.prepare(
    `SELECT price, currency, as_of FROM price_points
     WHERE user_id = ? AND symbol = ? AND as_of <= ?
     ORDER BY as_of DESC LIMIT 1`
  ).get(userId, symbol, date) as PriceLookup | undefined;
  return row ?? null;
}

/** Newest manually-entered rate for base→quote dated on-or-before `date`. */
function rateOnOrBefore(
  db: Database.Database,
  userId: number,
  base: Currency,
  quote: Currency,
  date: string
): number | null {
  const row = db.prepare(
    `SELECT rate FROM fx_rates
     WHERE user_id = ? AND base = ? AND quote = ? AND as_of <= ?
     ORDER BY as_of DESC LIMIT 1`
  ).get(userId, base, quote, date) as { rate: number } | undefined;
  return row?.rate ?? null;
}

export interface Conversion {
  rate: number;
  /** True when no rate has been entered yet — amounts pass through unconverted. */
  missing: boolean;
}

/**
 * Resolve a from→to conversion factor for `date`. Accepts a rate entered in
 * either direction (USD→ILS also serves ILS→USD, inverted). Never invents a
 * rate: when none exists it returns rate 1 with `missing: true` so callers can
 * flag the number instead of quietly reporting a wrong total.
 */
export function conversion(
  db: Database.Database,
  userId: number,
  from: Currency,
  to: Currency,
  date: string
): Conversion {
  if (from === to) return { rate: 1, missing: false };

  const direct = rateOnOrBefore(db, userId, from, to, date);
  if (direct != null) return { rate: direct, missing: false };

  const inverse = rateOnOrBefore(db, userId, to, from, date);
  if (inverse != null && inverse !== 0) return { rate: 1 / inverse, missing: false };

  return { rate: 1, missing: true };
}

// ── Account valuation ─────────────────────────────────────────────────────────

export interface AccountRow {
  id: number;
  user_id: number;
  name: string;
  kind: string;
  valuation_mode: ValuationMode;
  funding_mode: string;
  currency: Currency;
  symbol: string | null;
  fee_deposit_pct: number | null;
  fee_balance_annual_pct: number | null;
  notes: string | null;
  closed_at: string | null;
  archived_at: string | null;
}

export interface AccountValuation {
  account_id: number;
  name: string;
  kind: string;
  valuation_mode: ValuationMode;
  funding_mode: string;
  currency: Currency;
  symbol: string | null;

  // ── The decomposition, in the ACCOUNT's own currency ──
  value: number;
  principal: number;
  gross_earnings: number;
  fees: number;
  /** Portion of `fees` that is an un-trued-up estimate. */
  fees_estimated: number;

  // ── Same figures converted to the requested display currency ──
  display_currency: Currency;
  value_display: number;
  principal_display: number;
  gross_earnings_display: number;
  fees_display: number;
  fx_rate_used: number;
  /** No FX rate entered for this pair/date — display figures are unconverted. */
  fx_missing: boolean;

  // ── Market-account detail ──
  quantity: number;
  price_used: number | null;
  price_as_of: string | null;
  /** No price entered yet — value falls back to cost basis. */
  price_missing: boolean;
  realized_gain: number;

  // ── Balance-account detail ──
  last_balance_on: string | null;

  /** A sell exceeded units held — data-entry mistake worth surfacing. */
  oversold_units: number;
  as_of: string;
}

function sumEntries(
  db: Database.Database,
  accountId: number,
  kind: string,
  date: string,
  extra = ""
): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM entries
     WHERE account_id = ? AND kind = ? AND occurred_on <= ? ${extra}`
  ).get(accountId, kind, date) as { total: number };
  return row.total;
}

/**
 * Raw value used as the base for fee accrual. Deliberately independent of fee
 * rows so accrual can never feed back into itself.
 */
export function accrualBaseAt(
  db: Database.Database,
  account: AccountRow,
  date: string
): number {
  if (account.valuation_mode === "market") {
    const pos = fifoPosition(loadLotEvents(db, account.id, date));
    const p = account.symbol ? priceOnOrBefore(db, account.user_id, account.symbol, date) : null;
    return p ? pos.quantity * p.price : pos.cost_basis;
  }
  const snap = latestBalance(db, account.id, date);
  if (snap) return snap.amount;
  return sumEntries(db, account.id, "deposit", date) - sumEntries(db, account.id, "withdrawal", date);
}

function loadLotEvents(db: Database.Database, accountId: number, date: string): LotEvent[] {
  return db.prepare(
    `SELECT kind, quantity, price_per_unit, occurred_on FROM entries
     WHERE account_id = ? AND kind IN ('buy','sell') AND occurred_on <= ?
     ORDER BY occurred_on ASC, id ASC`
  ).all(accountId, date) as LotEvent[];
}

function latestBalance(
  db: Database.Database,
  accountId: number,
  date: string
): { amount: number; occurred_on: string } | null {
  const row = db.prepare(
    `SELECT amount, occurred_on FROM entries
     WHERE account_id = ? AND kind = 'balance' AND occurred_on <= ?
     ORDER BY occurred_on DESC, id DESC LIMIT 1`
  ).get(accountId, date) as { amount: number; occurred_on: string } | undefined;
  return row ?? null;
}

function firstBalance(
  db: Database.Database,
  accountId: number
): { amount: number; occurred_on: string } | null {
  const row = db.prepare(
    `SELECT amount, occurred_on FROM entries
     WHERE account_id = ? AND kind = 'balance'
     ORDER BY occurred_on ASC, id ASC LIMIT 1`
  ).get(accountId) as { amount: number; occurred_on: string } | undefined;
  return row ?? null;
}

/**
 * Value + decompose one account as of `date`, reported both in the account's own
 * currency and converted to `displayCurrency`.
 */
export function valueAccount(
  db: Database.Database,
  account: AccountRow,
  displayCurrency: Currency,
  date: string = today()
): AccountValuation {
  const feeRow = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total,
            COALESCE(SUM(CASE WHEN is_estimate = 1 THEN amount END), 0) AS estimated
     FROM entries WHERE account_id = ? AND kind = 'fee' AND occurred_on <= ?`
  ).get(account.id, date) as { total: number; estimated: number };
  const fees = feeRow.total;

  let value = 0;
  let principal = 0;
  let quantity = 0;
  let price_used: number | null = null;
  let price_as_of: string | null = null;
  let price_missing = false;
  let realized_gain = 0;
  let oversold_units = 0;
  let last_balance_on: string | null = null;

  if (account.valuation_mode === "market") {
    const pos = fifoPosition(loadLotEvents(db, account.id, date));
    quantity = pos.quantity;
    principal = pos.cost_basis;
    realized_gain = pos.realized_gain;
    oversold_units = pos.oversold_units;

    const p = account.symbol ? priceOnOrBefore(db, account.user_id, account.symbol, date) : null;
    if (p) {
      price_used = p.price;
      price_as_of = p.as_of;
      // A price entered in another currency is converted into the account's.
      const c = conversion(db, account.user_id, p.currency, account.currency, date);
      value = quantity * p.price * c.rate;
    } else {
      // No price entered yet: hold at cost rather than reporting zero.
      price_missing = quantity > 0;
      value = pos.cost_basis;
    }
  } else {
    const snap = latestBalance(db, account.id, date);
    const withdrawals = sumEntries(db, account.id, "withdrawal", date);

    if (snap) {
      value = snap.amount;
      last_balance_on = snap.occurred_on;

      // Opening principal: if deposits were logged up to (and including) the
      // first snapshot they explain the balance; otherwise the first snapshot
      // itself IS principal — an opening balance is money you put in, never profit.
      const first = firstBalance(db, account.id)!;
      const depositsUpToFirst = sumEntries(db, account.id, "deposit", first.occurred_on);
      const opening = depositsUpToFirst > 0 ? depositsUpToFirst : first.amount;
      const depositsAfter =
        sumEntries(db, account.id, "deposit", date) - depositsUpToFirst;

      principal = opening + depositsAfter - withdrawals;
    } else {
      // Funded but no statement yet: hold at cost, earnings unknown (= 0).
      const deposits = sumEntries(db, account.id, "deposit", date);
      principal = deposits - withdrawals;
      value = principal - fees;
    }
  }

  const gross_earnings = value - principal + fees;

  const conv = conversion(db, account.user_id, account.currency, displayCurrency, date);
  const toDisplay = (n: number) => n * conv.rate;

  return {
    account_id: account.id,
    name: account.name,
    kind: account.kind,
    valuation_mode: account.valuation_mode,
    funding_mode: account.funding_mode,
    currency: account.currency,
    symbol: account.symbol,

    value,
    principal,
    gross_earnings,
    fees,
    fees_estimated: feeRow.estimated,

    display_currency: displayCurrency,
    value_display: toDisplay(value),
    principal_display: toDisplay(principal),
    gross_earnings_display: toDisplay(gross_earnings),
    fees_display: toDisplay(fees),
    fx_rate_used: conv.rate,
    fx_missing: conv.missing,

    quantity,
    price_used,
    price_as_of,
    price_missing,
    realized_gain,

    last_balance_on,
    oversold_units,
    as_of: date,
  };
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export interface PortfolioTotals {
  as_of: string;
  display_currency: Currency;
  value: number;
  principal: number;
  gross_earnings: number;
  fees: number;
  fees_estimated: number;
  /** earnings as % of principal */
  return_pct: number | null;
  /** fees as % of principal — the drag */
  fee_pct_of_principal: number | null;
  /** Accounts whose display figures are unconverted for lack of an FX rate. */
  fx_missing_accounts: string[];
  /** Market accounts with units but no price entered. */
  price_missing_accounts: string[];
  accounts: AccountValuation[];
}

export function loadAccounts(db: Database.Database, userId: number, includeArchived = false): AccountRow[] {
  return db.prepare(
    `SELECT * FROM accounts
     WHERE user_id = ? ${includeArchived ? "" : "AND archived_at IS NULL"}
     ORDER BY name COLLATE NOCASE`
  ).all(userId) as AccountRow[];
}

export function computePortfolio(
  db: Database.Database,
  userId: number,
  displayCurrency: Currency,
  date: string = today()
): PortfolioTotals {
  const accounts = loadAccounts(db, userId).map(a => valueAccount(db, a, displayCurrency, date));

  const sum = (pick: (a: AccountValuation) => number) => accounts.reduce((s, a) => s + pick(a), 0);
  const value = sum(a => a.value_display);
  const principal = sum(a => a.principal_display);
  const gross_earnings = sum(a => a.gross_earnings_display);
  const fees = sum(a => a.fees_display);

  return {
    as_of: date,
    display_currency: displayCurrency,
    value,
    principal,
    gross_earnings,
    fees,
    fees_estimated: sum(a => a.fees_estimated * a.fx_rate_used),
    return_pct: principal > 0 ? (gross_earnings / principal) * 100 : null,
    fee_pct_of_principal: principal > 0 ? (fees / principal) * 100 : null,
    fx_missing_accounts: accounts.filter(a => a.fx_missing).map(a => a.name),
    price_missing_accounts: accounts.filter(a => a.price_missing).map(a => a.name),
    accounts,
  };
}
