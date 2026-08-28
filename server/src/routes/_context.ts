/**
 * Turns stored settings into the options the calc engine takes, and turns a
 * range name ("3M" / "1Y" / "YTD" / "ALL") into the list of dates a chart
 * should be sampled at.
 */

import type Database from "better-sqlite3";
import {
  DEFAULT_OPTIONS, accountValueOn, addDays, addMonths, eachDay, eachMonthEnd, feesPaidOn,
  firstActivityDate, forAccount, isIsoDate, netPrincipalOn, numSetting, resolveFx, scaleMinor, today,
  type AccountRow, type CalcOptions, type Currency, type IsoDate, type Ledger,
  type RsuPrincipalBasis, type SeriesPoint,
} from "../calc/index.js";
import { HttpError, qEnum, qInt } from "./_validate.js";
import type { Request } from "express";

export function calcOptions(db: Database.Database): CalcOptions {
  const basis = db.prepare("SELECT value FROM settings WHERE key = 'rsu_principal_basis'")
    .get() as { value: string } | undefined;
  return {
    rsuPrincipalBasis: (basis?.value === "vest_price" ? "vest_price" : "zero_cost") as RsuPrincipalBasis,
    staleDataDays: numSetting(db, "stale_data_days", DEFAULT_OPTIONS.staleDataDays),
    staleFxDays: numSetting(db, "stale_fx_days", DEFAULT_OPTIONS.staleFxDays),
  };
}

/** Display currency for this request: ?currency= wins, else the stored setting. */
export function requestCurrency(req: Request, db: Database.Database): Currency {
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'display_currency'")
    .get() as { value: string } | undefined;
  const fallback: Currency = stored?.value === "USD" ? "USD" : "ILS";
  return qEnum(req, "currency", ["ILS", "USD"] as const, fallback);
}

export const RANGES = ["3M", "1Y", "YTD", "ALL"] as const;
export type Range = typeof RANGES[number];

/**
 * Sample dates for a range, always ending on `asOf` so the chart's last point
 * matches the headline number exactly.
 *
 * Short ranges are sampled weekly and long ones monthly: a phone-width chart
 * cannot show more than ~60 points legibly, and every extra point costs a full
 * revaluation of the whole ledger.
 */
export function rangeDates(ledger: Ledger, range: Range, asOf: IsoDate = today()): IsoDate[] {
  const first = firstActivityDate(ledger);
  let start: IsoDate;

  switch (range) {
    case "3M":  start = addMonths(asOf, -3); break;
    case "1Y":  start = addMonths(asOf, -12); break;
    case "YTD": start = `${asOf.slice(0, 4)}-01-01`; break;
    case "ALL": start = first ?? addMonths(asOf, -12); break;
  }
  // Never start the chart before there was anything to chart — a long flat
  // run of zeros makes the interesting part unreadable.
  if (first && start < first) start = first;
  if (start > asOf) start = asOf;

  const spanDays = (Date.parse(asOf) - Date.parse(start)) / 86_400_000;
  const dates: IsoDate[] = [];

  if (spanDays <= 400) {
    const step = spanDays <= 100 ? 7 : 14;
    for (let d = start; d < asOf; d = addDays(d, step)) dates.push(d);
  } else {
    dates.push(...eachMonthEnd(start, asOf).filter(d => d < asOf));
  }

  dates.push(asOf);
  return dates;
}

/**
 * Decompose a set of accounts across a list of dates, in display currency.
 *
 * The reason this exists rather than calling `portfolioSeries` directly: an
 * account whose first price or balance lands in February still has January
 * deposits. Counted naively, those deposits are principal against a value of
 * zero — a phantom 100% loss at the left edge of every chart, big enough to
 * flatten the part you actually wanted to read.
 *
 * So an account contributes NOTHING at a date it cannot be valued at. Not its
 * value, and not its principal either. You cannot decompose what you cannot
 * value, and showing the principal half alone is worse than showing neither.
 */
export function decomposeSeries(
  ledger: Ledger,
  accounts: AccountRow[],
  dates: IsoDate[],
  displayCurrency: Currency,
  options: CalcOptions
): SeriesPoint[] {
  const perAccount = accounts.map(account => {
    const scoped = forAccount(ledger, account.id);
    return dates.map(date => {
      const v = accountValueOn(scoped, account, date, options);
      if (v.flags.includes("no_data")) {
        return { value_minor: 0, principal_minor: 0, earnings_minor: 0, fees_minor: 0 };
      }
      const fx = resolveFx(ledger.fx, account.currency, displayCurrency, date, options.staleFxDays);
      const d = (m: number) => scaleMinor(m, fx.rate);
      const principal = netPrincipalOn(scoped, date, options);
      return {
        value_minor: d(v.value_minor),
        principal_minor: d(principal),
        earnings_minor: d(v.value_minor - principal),
        fees_minor: d(feesPaidOn(scoped, date)),
      };
    });
  });

  return dates.map((date, i) => ({
    date,
    value_minor: perAccount.reduce((s, p) => s + p[i].value_minor, 0),
    principal_minor: perAccount.reduce((s, p) => s + p[i].principal_minor, 0),
    earnings_minor: perAccount.reduce((s, p) => s + p[i].earnings_minor, 0),
    fees_minor: perAccount.reduce((s, p) => s + p[i].fees_minor, 0),
  }));
}

// ── projection ───────────────────────────────────────────────────────────────

import { projection as _projection } from "../calc/index.js";

export interface ProjectionQuery {
  years: number;
  annualReturnPct: number;
}

/** Parse ?years= & ?annual_return_pct= with sane, bounded defaults. */
export function projectionQuery(req: Request): ProjectionQuery {
  const years = qInt(req, "years", 10, 100);
  const raw = req.query.annual_return_pct;
  const annualReturnPct = raw == null || raw === "" ? 6 : Number(raw);
  if (!Number.isFinite(annualReturnPct) || annualReturnPct <= -100 || annualReturnPct > 100) {
    throw new HttpError("annual_return_pct must be a number between −99 and 100", 400);
  }
  return { years: Math.max(1, years), annualReturnPct };
}

/**
 * Build one account's projection from where it stands today: current value as
 * the lump sum, its recurring rules as the contribution stream, its configured
 * fee percentages as the drag. Returns null for an account that cannot be
 * valued yet — projecting an unknown forward would just be a random number.
 */
export function projectAccount(
  db: Database.Database,
  ledger: Ledger,
  account: AccountRow,
  q: ProjectionQuery,
  options: CalcOptions,
  asOf: IsoDate
) {
  const scoped = forAccount(ledger, account.id);
  const v = accountValueOn(scoped, account, asOf, options);
  if (v.flags.includes("no_data")) return null;

  const rules = db.prepare(
    "SELECT frequency, amount_minor, is_active, end_date FROM recurring_rules WHERE account_id = ?"
  ).all(account.id) as { frequency: string; amount_minor: number; is_active: number; end_date: string | null }[];

  const input = {
    start_value_minor: v.value_minor,
    monthly_contribution_minor: _projection.monthlyContributionOf(rules, asOf),
    annual_return_pct: q.annualReturnPct,
    annual_balance_fee_pct: account.mgmt_fee_balance_pct ?? 0,
    deposit_fee_pct: account.mgmt_fee_deposit_pct ?? 0,
    months: q.years * 12,
  };
  return { input, result: _projection.project(input) };
}

/**
 * Sample dates for a series request. Two addressing modes:
 *
 *   ?range=3M|1Y|YTD|ALL                    — the app's toggles
 *   ?from=&to=&granularity=daily|monthly    — explicit window, for tooling
 *
 * Explicit from/to wins when present. Daily grids are capped at ~3 years per
 * request: every point is a full revaluation of the ledger, and a 40-year
 * daily series is a way to hang a Raspberry Pi, not a chart anyone can read.
 */
export function seriesDates(req: Request, ledger: Ledger, asOf: IsoDate): IsoDate[] {
  const rawFrom = req.query.from;
  const rawTo = req.query.to;
  if (rawFrom == null && rawTo == null) {
    return rangeDates(ledger, qEnum<Range>(req, "range", RANGES, "1Y"), asOf);
  }

  const to = rawTo == null || rawTo === "" ? asOf : rawTo;
  const from = rawFrom == null || rawFrom === ""
    ? (firstActivityDate(ledger) ?? to)
    : rawFrom;
  if (!isIsoDate(from) || !isIsoDate(to)) {
    throw new HttpError("from/to must be dates as YYYY-MM-DD", 400);
  }
  if (from > to) throw new HttpError("from must be on or before to", 400);

  const granularity = qEnum(req, "granularity", ["daily", "monthly"] as const, "monthly");
  if (granularity === "daily") {
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 1100) {
      throw new HttpError("daily granularity is limited to a 3-year window — use monthly", 400);
    }
    return eachDay(from, to);
  }
  const dates = eachMonthEnd(from, to).filter(d => d < to);
  dates.push(to);
  return dates;
}
