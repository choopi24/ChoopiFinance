/**
 * THE CALCULATION ENGINE — pure functions over an in-memory Ledger.
 *
 * No SQL, no clock, no I/O: every answer is a function of (ledger, date,
 * options), which is why the series builder can ask for 400 dates without 400
 * queries, and why the tests can construct exact scenarios by hand.
 *
 * ── The model ──────────────────────────────────────────────────────────────
 *
 * VALUE on date D
 *   market  : Σ over holdings of (units held on D) × (last price on-or-before D)
 *             PLUS uninvested cash sitting in the account
 *   balance : the last balance snapshot on-or-before D
 *   Nothing on-or-before D → the account contributes 0 and is flagged 'no_data'.
 *
 * NET PRINCIPAL on date D — money that came out of MY pocket or salary.
 *   Only flows that CROSS THE ACCOUNT BOUNDARY count: deposits (+) and
 *   withdrawals (−). buy/sell/fee/dividend are internal — a buy converts cash
 *   already inside the account into units, so counting it again would double.
 *
 *   Except: many people record a brokerage buy without first recording the
 *   deposit that funded it. That leaves the cash balance negative, and the
 *   shortfall can only have come from your pocket. So a negative cash balance is
 *   treated as an implied deposit of the same size (and cash floors at zero).
 *   Both styles therefore give the right principal:
 *       deposit 1000 → buy 960 → fee 1 : principal 1000, cash 39, value 999
 *       buy 960 → fee 1 (no deposit)   : principal  961, cash  0, value 960
 *
 *   RSU vests add principal per `rsuPrincipalBasis`: 'zero_cost' (default —
 *   the shares cost you nothing) or 'vest_price' (units × price at vest, the
 *   amount you were taxed on).
 *
 * FEES on date D    Σ of 'fee' rows (stored negative, reported positive).
 * EARNINGS on D     net   = value − net_principal
 *                   gross = net + fees_paid
 *   For a balance account the statement already had fees deducted, so `net` is
 *   what you actually made and `gross` is what you'd have made without the drag.
 */

import { pctOfMinor, safePct, scaleMinor } from "./money.js";
import { addMonths, daysBetween, eachMonthEnd, monthEnd, monthStart, type IsoDate } from "./dates.js";
import { resolveFx } from "./fx.js";
import { xirr } from "./returns.js";
import {
  DEFAULT_OPTIONS,
  type AccountRow, type AccountSummary, type CalcFlag, type CalcOptions,
  type Currency, type Ledger, type SeriesPoint,
} from "./types.js";

// ── Ledger slicing ───────────────────────────────────────────────────────────

/** A ledger narrowed to one account, so per-account maths never scans the rest. */
export function forAccount(ledger: Ledger, accountId: number): Ledger {
  const holdings = ledger.holdings.filter(h => h.account_id === accountId);
  const holdingIds = new Set(holdings.map(h => h.id));
  const grants = ledger.grants.filter(g => g.account_id === accountId);
  const grantIds = new Set(grants.map(g => g.id));
  return {
    accounts: ledger.accounts.filter(a => a.id === accountId),
    holdings,
    prices: ledger.prices.filter(p => holdingIds.has(p.holding_id)),
    transactions: ledger.transactions.filter(t => t.account_id === accountId),
    valuations: ledger.valuations.filter(v => v.account_id === accountId),
    fx: ledger.fx,
    grants,
    vests: ledger.vests.filter(v => grantIds.has(v.grant_id)),
  };
}

// ── Units and prices ─────────────────────────────────────────────────────────

/** Newest price for a holding on-or-before `date`, or null. */
export function priceOn(ledger: Ledger, holdingId: number, date: IsoDate): { price_minor: number; date: IsoDate } | null {
  let found: { price_minor: number; date: IsoDate } | null = null;
  for (const p of ledger.prices) {
    if (p.holding_id !== holdingId) continue;
    if (p.date > date) continue;
    if (!found || p.date > found.date) found = { price_minor: p.price_minor, date: p.date };
  }
  return found;
}

/**
 * Units of a holding held on `date`: traded units, plus RSU units that have
 * actually vested (net of shares sold to cover withholding tax). Unvested units
 * are never included — they are not yours yet.
 */
export function unitsHeldOn(ledger: Ledger, holdingId: number, date: IsoDate): number {
  const holding = ledger.holdings.find(h => h.id === holdingId);
  let units = 0;

  for (const t of ledger.transactions) {
    if (t.holding_id !== holdingId || t.date > date || t.quantity == null) continue;
    if (t.type === "buy") units += t.quantity;
    else if (t.type === "sell") units -= t.quantity;
  }

  if (holding) {
    for (const v of vestedOn(ledger, date)) {
      const grant = ledger.grants.find(g => g.id === v.grant_id);
      if (grant && grant.account_id === holding.account_id && grant.symbol === holding.symbol) {
        units += v.units - v.units_sold_to_cover_tax;
      }
    }
  }
  return units;
}

/** Vests whose date has arrived and which are not cancelled. */
export function vestedOn(ledger: Ledger, date: IsoDate) {
  return ledger.vests.filter(v => v.status !== "cancelled" && v.vest_date <= date);
}

/** Units granted but not yet vested as of `date` (reported, never valued). */
export function unvestedUnitsOn(ledger: Ledger, date: IsoDate): number {
  return ledger.vests
    .filter(v => v.status !== "cancelled" && v.vest_date > date)
    .reduce((s, v) => s + v.units, 0);
}

// ── Value ────────────────────────────────────────────────────────────────────

export interface ValueBreakdown {
  value_minor: number;
  holdings_value_minor: number;
  cash_minor: number;
  last_data_date: IsoDate | null;
  flags: CalcFlag[];
}

/**
 * Cash sitting in the account: the signed sum of every row. Negative means buys
 * were recorded without the funding deposit — see the principal note above.
 */
function rawCashOn(ledger: Ledger, date: IsoDate): number {
  return ledger.transactions
    .filter(t => t.date <= date)
    .reduce((s, t) => s + t.amount_minor, 0);
}

export function accountValueOn(
  ledger: Ledger,
  account: AccountRow,
  date: IsoDate,
  options: CalcOptions = DEFAULT_OPTIONS
): ValueBreakdown {
  const flags: CalcFlag[] = [];

  if (account.valuation_mode === "balance") {
    let latest: { balance_minor: number; date: IsoDate } | null = null;
    for (const v of ledger.valuations) {
      if (v.date > date) continue;
      if (!latest || v.date > latest.date) latest = { balance_minor: v.balance_minor, date: v.date };
    }
    if (!latest) {
      return { value_minor: 0, holdings_value_minor: 0, cash_minor: 0, last_data_date: null, flags: ["no_data"] };
    }
    if (daysBetween(latest.date, date) > options.staleDataDays) flags.push("stale_data");
    return {
      value_minor: latest.balance_minor,
      holdings_value_minor: latest.balance_minor,
      cash_minor: 0,
      last_data_date: latest.date,
      flags,
    };
  }

  // market
  let holdingsValue = 0;
  let lastPriceDate: IsoDate | null = null;
  let anyUnits = false;
  let missingPrice = false;

  for (const h of ledger.holdings) {
    const units = unitsHeldOn(ledger, h.id, date);
    if (Math.abs(units) < 1e-9) continue;
    anyUnits = true;
    const p = priceOn(ledger, h.id, date);
    if (!p) { missingPrice = true; continue; }
    // A price kept in another currency is converted into the account's.
    const fx = resolveFx(ledger.fx, h.currency, account.currency, date, options.staleFxDays);
    if (fx.missing) flags.push("missing_fx");
    holdingsValue += scaleMinor(Math.round(units * p.price_minor), fx.rate);
    if (!lastPriceDate || p.date > lastPriceDate) lastPriceDate = p.date;
  }

  if (missingPrice) flags.push("missing_price");

  const cash = Math.max(0, rawCashOn(ledger, date));
  const anyTx = ledger.transactions.some(t => t.date <= date);

  if (!anyTx && !anyUnits) {
    return { value_minor: 0, holdings_value_minor: 0, cash_minor: 0, last_data_date: null, flags: ["no_data"] };
  }
  if (anyUnits && !lastPriceDate) flags.push("no_data");
  if (lastPriceDate && daysBetween(lastPriceDate, date) > options.staleDataDays) {
    flags.push("stale_data");
  }

  return {
    value_minor: holdingsValue + cash,
    holdings_value_minor: holdingsValue,
    cash_minor: cash,
    last_data_date: lastPriceDate,
    flags: [...new Set(flags)],
  };
}

// ── Net principal ────────────────────────────────────────────────────────────

export function netPrincipalOn(
  ledger: Ledger,
  date: IsoDate,
  options: CalcOptions = DEFAULT_OPTIONS
): number {
  let external = 0;
  for (const t of ledger.transactions) {
    if (t.date > date) continue;
    if (t.type === "deposit" || t.type === "withdrawal") external += t.amount_minor;
  }

  // Buys recorded without a funding deposit came out of pocket, so the
  // shortfall is principal too.
  //
  // Withdrawals are EXCLUDED from this test. Taking money out is not an
  // unfunded purchase, and counting it as one lets a withdrawal manufacture
  // principal: deposit 1,000, buy 900, withdraw 500 leaves cash at −400, which
  // the naive test reads as "400 came out of pocket" and adds back — reporting
  // 900 of principal against 500 actually contributed, and understating
  // earnings by the same 400.
  const fundingCash = ledger.transactions
    .filter(t => t.date <= date && t.type !== "withdrawal")
    .reduce((sum, t) => sum + t.amount_minor, 0);
  const implied = fundingCash < 0 ? -fundingCash : 0;

  let rsu = 0;
  if (options.rsuPrincipalBasis === "vest_price") {
    for (const v of vestedOn(ledger, date)) {
      if (v.price_at_vest_minor == null) continue;
      const net = v.units - v.units_sold_to_cover_tax;
      rsu += Math.round(net * v.price_at_vest_minor);
    }
  }

  return external + implied + rsu;
}

// ── Fees ─────────────────────────────────────────────────────────────────────

/** Fees actually recorded, returned POSITIVE (they are stored negative). */
export function feesPaidOn(ledger: Ledger, date: IsoDate): number {
  return -ledger.transactions
    .filter(t => t.type === "fee" && t.date <= date)
    .reduce((s, t) => s + t.amount_minor, 0);
}

export function feesPaidByKindOn(ledger: Ledger, date: IsoDate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ledger.transactions) {
    if (t.type !== "fee" || t.date > date) continue;
    const k = t.fee_kind ?? "other";
    out[k] = (out[k] ?? 0) - t.amount_minor;
  }
  return out;
}

/**
 * What the configured percentages IMPLY the fund has charged — an independent
 * estimate for sanity-checking a statement, never used as the real figure.
 *   deposit part: mgmt_fee_deposit_pct × each deposit
 *   balance part: mgmt_fee_balance_pct / 12 × the balance at each month end
 */
export function feesEstimatedOn(
  ledger: Ledger,
  account: AccountRow,
  date: IsoDate,
  options: CalcOptions = DEFAULT_OPTIONS
): number {
  let total = 0;

  const depositPct = account.mgmt_fee_deposit_pct ?? 0;
  if (depositPct > 0) {
    for (const t of ledger.transactions) {
      if (t.type === "deposit" && t.date <= date) total += pctOfMinor(t.amount_minor, depositPct);
    }
  }

  const balancePct = account.mgmt_fee_balance_pct ?? 0;
  if (balancePct > 0) {
    const first = firstActivityDate(ledger);
    if (first) {
      for (const me of eachMonthEnd(first, date)) {
        // Charge on the balance as observed, which excludes fee rows entirely,
        // so this estimate can never feed on itself.
        const v = accountValueOn(ledger, account, me, options);
        total += pctOfMinor(v.value_minor, balancePct / 12);
      }
    }
  }

  return total;
}

export function firstActivityDate(ledger: Ledger): IsoDate | null {
  const dates: IsoDate[] = [
    ...ledger.transactions.map(t => t.date),
    ...ledger.valuations.map(v => v.date),
    ...ledger.vests.filter(v => v.status !== "cancelled").map(v => v.vest_date),
  ];
  return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Simple return, but only where the question means anything.
 *
 * A percentage return needs a positive base. Once you have withdrawn more than
 * you ever paid in, net principal goes negative and the ratio inverts: a real
 * gain of 30,500 against −20,000 of principal prints as −152.5%, which reads as
 * a catastrophic loss and is the exact opposite of the truth. There is no
 * meaningful percentage to show there, so we show none and let the UI print a
 * dash next to the money figure, which is still exactly right.
 */
function returnPct(earnings: number, principal: number): number | null {
  return principal > 0 ? safePct(earnings, principal) : null;
}

export function summarizeAccount(
  fullLedger: Ledger,
  account: AccountRow,
  date: IsoDate,
  displayCurrency: Currency,
  options: CalcOptions = DEFAULT_OPTIONS
): AccountSummary {
  const ledger = forAccount(fullLedger, account.id);

  const v = accountValueOn(ledger, account, date, options);
  const principal = netPrincipalOn(ledger, date, options);
  const feesPaid = feesPaidOn(ledger, date);
  const feesEst = feesEstimatedOn(ledger, account, date, options);

  const netEarnings = v.value_minor - principal;
  const grossEarnings = netEarnings + feesPaid;

  const fx = resolveFx(ledger.fx, account.currency, displayCurrency, date, options.staleFxDays);
  const flags = new Set<CalcFlag>(v.flags);
  if (fx.missing) flags.add("missing_fx");
  if (fx.stale) flags.add("stale_fx");
  const d = (m: number) => scaleMinor(m, fx.rate);

  const cashflows = principalCashflows(ledger, date, options);
  const mwr = xirr([...cashflows, { date, amount: v.value_minor }]);

  return {
    account_id: account.id,
    name: account.name,
    category: account.category,
    valuation_mode: account.valuation_mode,
    funding_mode: account.funding_mode,
    currency: account.currency,
    as_of: date,

    value_minor: v.value_minor,
    net_principal_minor: principal,
    net_earnings_minor: netEarnings,
    gross_earnings_minor: grossEarnings,
    fees_paid_minor: feesPaid,
    fees_estimated_minor: feesEst,

    display_currency: displayCurrency,
    value_display_minor: d(v.value_minor),
    net_principal_display_minor: d(principal),
    net_earnings_display_minor: d(netEarnings),
    gross_earnings_display_minor: d(grossEarnings),
    fees_paid_display_minor: d(feesPaid),
    fees_estimated_display_minor: d(feesEst),
    fx_rate_used: fx.rate,

    simple_return_pct: returnPct(netEarnings, principal),
    money_weighted_return_pct: mwr == null ? null : Math.round(mwr * 1_000_000) / 10_000,

    holdings_value_minor: v.holdings_value_minor,
    cash_minor: v.cash_minor,
    unvested_units: unvestedUnitsOn(ledger, date),
    vested_units: vestedOn(ledger, date).reduce((s, x) => s + x.units, 0),

    last_data_date: v.last_data_date,
    balance_is_net_of_fees: account.valuation_mode === "balance",
    flags: [...flags],
  };
}

/**
 * Cash flows for the money-weighted return, from the investor's perspective:
 * money you put in is negative, money you take out is positive. The terminal
 * value is appended by the caller.
 */
export function principalCashflows(
  ledger: Ledger,
  date: IsoDate,
  options: CalcOptions = DEFAULT_OPTIONS
): { date: IsoDate; amount: number }[] {
  const flows: { date: IsoDate; amount: number }[] = [];

  for (const t of ledger.transactions) {
    if (t.date > date) continue;
    if (t.type === "deposit" || t.type === "withdrawal") flows.push({ date: t.date, amount: -t.amount_minor });
  }

  // An implied deposit (buys with no funding row) is dated at the first such buy.
  let running = 0;
  let impliedDate: IsoDate | null = null;
  const sorted = [...ledger.transactions].filter(t => t.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    running += t.amount_minor;
    if (running < 0 && impliedDate == null) impliedDate = t.date;
  }
  if (running < 0 && impliedDate) flows.push({ date: impliedDate, amount: running });

  if (options.rsuPrincipalBasis === "vest_price") {
    for (const v of vestedOn(ledger, date)) {
      if (v.price_at_vest_minor == null) continue;
      const net = v.units - v.units_sold_to_cover_tax;
      flows.push({ date: v.vest_date, amount: -Math.round(net * v.price_at_vest_minor) });
    }
  }

  return flows.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Series ───────────────────────────────────────────────────────────────────

/**
 * Decomposition at each date. Because every figure is a point-in-time function
 * of the ledger, carry-forward of the last known price/balance is automatic —
 * there is no separate "fill gaps" step to get wrong.
 */
export function accountSeries(
  fullLedger: Ledger,
  account: AccountRow,
  dates: IsoDate[],
  displayCurrency: Currency,
  options: CalcOptions = DEFAULT_OPTIONS
): SeriesPoint[] {
  const ledger = forAccount(fullLedger, account.id);
  return dates.map(date => {
    const v = accountValueOn(ledger, account, date, options);
    const principal = netPrincipalOn(ledger, date, options);
    const fees = feesPaidOn(ledger, date);
    const fx = resolveFx(ledger.fx, account.currency, displayCurrency, date, options.staleFxDays);
    const d = (m: number) => scaleMinor(m, fx.rate);
    return {
      date,
      value_minor: d(v.value_minor),
      principal_minor: d(principal),
      earnings_minor: d(v.value_minor - principal),
      fees_minor: d(fees),
    };
  });
}

export function portfolioSeries(
  ledger: Ledger,
  dates: IsoDate[],
  displayCurrency: Currency,
  options: CalcOptions = DEFAULT_OPTIONS
): SeriesPoint[] {
  const per = ledger.accounts.map(a => accountSeries(ledger, a, dates, displayCurrency, options));
  return dates.map((date, i) => ({
    date,
    value_minor: per.reduce((s, p) => s + p[i].value_minor, 0),
    principal_minor: per.reduce((s, p) => s + p[i].principal_minor, 0),
    earnings_minor: per.reduce((s, p) => s + p[i].earnings_minor, 0),
    fees_minor: per.reduce((s, p) => s + p[i].fees_minor, 0),
  }));
}

// ── Portfolio ────────────────────────────────────────────────────────────────

export interface PortfolioSummary {
  as_of: IsoDate;
  display_currency: Currency;
  value_minor: number;
  net_principal_minor: number;
  net_earnings_minor: number;
  gross_earnings_minor: number;
  fees_paid_minor: number;
  fees_estimated_minor: number;
  simple_return_pct: number | null;
  money_weighted_return_pct: number | null;
  unvested_units: number;
  flags: CalcFlag[];
  /**
   * Accounts left OUT of the totals because they cannot be valued yet — see
   * summarizePortfolio. They still appear in `accounts` with their own figures.
   */
  excluded_accounts: { account_id: number; name: string; net_principal_minor: number }[];
  accounts: AccountSummary[];
}

export function summarizePortfolio(
  ledger: Ledger,
  date: IsoDate,
  displayCurrency: Currency,
  options: CalcOptions = DEFAULT_OPTIONS
): PortfolioSummary {
  const accounts = ledger.accounts.map(a =>
    summarizeAccount(ledger, a, date, displayCurrency, options));

  /**
   * An account with deposits but no price or balance yet cannot be decomposed:
   * its value is unknown, not zero. Counting its principal while treating its
   * value as zero would report the whole deposit as a LOSS — so a brand new
   * account, correctly funded, would knock the portfolio's earnings down by
   * exactly what you just paid in.
   *
   * It is excluded from the totals instead, and named in `excluded_accounts` so
   * the UI can say what is missing rather than quietly misstating the total.
   * This is the same rule the charts use (see routes/_context.decomposeSeries),
   * which is what keeps the headline and the chart telling the same story.
   */
  const valued = accounts.filter(a => !a.flags.includes("no_data"));
  const excluded = accounts
    .filter(a => a.flags.includes("no_data"))
    .map(a => ({
      account_id: a.account_id,
      name: a.name,
      net_principal_minor: a.net_principal_display_minor,
    }));

  const sum = (f: (a: AccountSummary) => number) => valued.reduce((s, a) => s + f(a), 0);
  const value = sum(a => a.value_display_minor);
  const principal = sum(a => a.net_principal_display_minor);
  const fees = sum(a => a.fees_paid_display_minor);
  const netEarnings = value - principal;

  // Portfolio MWR: every account's flows converted to display currency at the
  // rate in force on the flow's own date, then solved once.
  const flows: { date: IsoDate; amount: number }[] = [];
  const valuedIds = new Set(valued.map(a => a.account_id));
  for (const a of ledger.accounts) {
    if (!valuedIds.has(a.id)) continue; // excluded above; its flows would skew the rate
    const sub = forAccount(ledger, a.id);
    for (const f of principalCashflows(sub, date, options)) {
      const fx = resolveFx(ledger.fx, a.currency, displayCurrency, f.date, options.staleFxDays);
      flows.push({ date: f.date, amount: scaleMinor(f.amount, fx.rate) });
    }
  }
  const mwr = xirr([...flows.sort((x, y) => x.date.localeCompare(y.date)), { date, amount: value }]);

  return {
    as_of: date,
    display_currency: displayCurrency,
    value_minor: value,
    net_principal_minor: principal,
    net_earnings_minor: netEarnings,
    gross_earnings_minor: netEarnings + fees,
    fees_paid_minor: fees,
    fees_estimated_minor: sum(a => a.fees_estimated_display_minor),
    simple_return_pct: returnPct(netEarnings, principal),
    money_weighted_return_pct: mwr == null ? null : Math.round(mwr * 1_000_000) / 10_000,
    unvested_units: sum(a => a.unvested_units),
    flags: [...new Set(accounts.flatMap(a => a.flags))],
    excluded_accounts: excluded,
    accounts,
  };
}
