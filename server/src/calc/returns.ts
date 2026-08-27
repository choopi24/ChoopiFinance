/**
 * Money-weighted return (XIRR) — the annualised rate that makes a series of
 * irregularly-timed cash flows net to zero. Necessary here because deposits
 * arrive monthly and lump sums land whenever, so a simple value/principal ratio
 * says nothing about *rate*.
 *
 * Contract: this NEVER returns NaN or Infinity. Any input for which a rate is
 * undefined or meaningless returns null, and the caller reports "n/a".
 */

import { daysBetween, type IsoDate } from "./dates.js";

export interface CashFlow {
  date: IsoDate;
  /** Investor perspective: money in is negative, money out / final value positive. */
  amount: number;
}

const DAYS_PER_YEAR = 365;
/**
 * The search bracket. The floor sits just above −100 % rather than at a round
 * −99.99 %: a near-total loss (put in ₪1,000, ₪0.01 left) has a true IRR of
 * about −99.999 %, and a shallower floor fails to bracket the root and would
 * report "n/a" for the one case the user most needs to see.
 */
const MIN_RATE = -0.999999;
const MAX_RATE = 1_000;

/** Net present value of the flows at annual rate `rate`. */
function npv(flows: CashFlow[], t0: IsoDate, rate: number): number {
  let sum = 0;
  for (const f of flows) {
    const years = daysBetween(t0, f.date) / DAYS_PER_YEAR;
    sum += f.amount / Math.pow(1 + rate, years);
  }
  return sum;
}

/**
 * Solve for the rate. Bisection rather than Newton–Raphson: it cannot diverge or
 * land on a derivative of zero, and for a handful of flows the extra iterations
 * are free. Returns null when no sign change exists in the bracket, which is
 * the honest answer for flows that admit no real IRR.
 */
export function xirr(input: CashFlow[]): number | null {
  const flows = input.filter(f => Number.isFinite(f.amount) && f.amount !== 0);
  if (flows.length < 2) return null;

  // An IRR requires money both in and out; all-one-sign has no solution.
  const hasNegative = flows.some(f => f.amount < 0);
  const hasPositive = flows.some(f => f.amount > 0);
  if (!hasNegative || !hasPositive) return null;

  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const t0 = sorted[0].date;
  // All flows on one day: no elapsed time, so no rate.
  if (sorted[sorted.length - 1].date === t0) return null;

  let lo = MIN_RATE;
  let hi = MAX_RATE;
  let fLo = npv(sorted, t0, lo);
  let fHi = npv(sorted, t0, hi);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo * fHi > 0) return null; // no root in the bracket

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(sorted, t0, mid);
    if (!Number.isFinite(fMid)) return null;
    if (Math.abs(fMid) < 1e-7 || hi - lo < 1e-9) {
      return Number.isFinite(mid) ? mid : null;
    }
    if (fLo * fMid <= 0) { hi = mid; fHi = fMid; }
    else                 { lo = mid; fLo = fMid; }
  }

  const result = (lo + hi) / 2;
  return Number.isFinite(result) ? result : null;
}
