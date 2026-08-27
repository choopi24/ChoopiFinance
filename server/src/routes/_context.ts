/**
 * Turns stored settings into the options the calc engine takes, and turns a
 * range name ("3M" / "1Y" / "YTD" / "ALL") into the list of dates a chart
 * should be sampled at.
 */

import type Database from "better-sqlite3";
import {
  DEFAULT_OPTIONS, addDays, addMonths, eachMonthEnd, firstActivityDate,
  numSetting, today,
  type CalcOptions, type Currency, type IsoDate, type Ledger, type RsuPrincipalBasis,
} from "../calc/index.js";
import { qEnum } from "./_validate.js";
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
