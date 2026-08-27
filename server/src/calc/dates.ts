/**
 * Date helpers. Dates are ISO 'YYYY-MM-DD' strings throughout — in that format
 * lexicographic order IS chronological order, so comparisons and BETWEEN work
 * without parsing. We only convert to Date for arithmetic, always in UTC so a
 * timezone can never shift a day.
 */

export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const isIsoDate = (s: unknown): s is IsoDate =>
  typeof s === "string" && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export const today = (): IsoDate => new Date().toISOString().slice(0, 10);

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Add months, clamping to the target month's length (Jan 31 + 1mo → Feb 28). */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const target = m - 1 + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  );
}

export const monthEnd = (date: IsoDate): IsoDate => {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const monthStart = (date: IsoDate): IsoDate => `${date.slice(0, 7)}-01`;

/** Clamp a day-of-month to a real date in that month. */
export function dayInMonth(year: number, month1: number, day: number): IsoDate {
  const lastDay = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return `${year}-${String(month1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** Every date from `from` to `to` inclusive. Guarded against runaway ranges. */
export function eachDay(from: IsoDate, to: IsoDate, maxDays = 4000): IsoDate[] {
  const out: IsoDate[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard++ < maxDays) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** Month-end dates from `from` to `to`, with `to` itself as the final point. */
export function eachMonthEnd(from: IsoDate, to: IsoDate, maxMonths = 600): IsoDate[] {
  const out: IsoDate[] = [];
  let cursor = monthEnd(from);
  let guard = 0;
  while (cursor < to && guard++ < maxMonths) {
    out.push(cursor);
    cursor = monthEnd(addDays(cursor, 1));
  }
  out.push(to);
  return out;
}
