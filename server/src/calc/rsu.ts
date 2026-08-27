/**
 * RSU vesting.
 *
 *   • Creating a grant expands cliff_months + vest_duration_months +
 *     vest_frequency into concrete rsu_vests rows. Everything accrued before
 *     the cliff is released in one tranche ON the cliff date; after that it
 *     vests every period to the end of the duration.
 *   • A vest whose date has arrived flips 'scheduled' → 'vested'.
 *   • Vested units (net of shares sold to cover withholding) roll into the
 *     linked market holding — see engine.unitsHeldOn.
 *   • Unvested units are reported separately and never valued.
 */

import type Database from "better-sqlite3";
import { addMonths, today, type IsoDate } from "./dates.js";
import type { GrantRow, VestStatus } from "./types.js";

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, annual: 12 } as const;

export interface PlannedVest { vest_date: IsoDate; units: number }

/**
 * Expand a grant into tranches. Units are distributed pro-rata by elapsed
 * months and the remainder lands on the final tranche, so the tranches always
 * sum to total_units exactly — no drift, no lost share.
 */
export function planVests(grant: {
  grant_date: IsoDate; total_units: number; cliff_months: number;
  vest_duration_months: number; vest_frequency: keyof typeof PERIOD_MONTHS;
}): PlannedVest[] {
  const step = PERIOD_MONTHS[grant.vest_frequency];
  const { cliff_months: cliff, vest_duration_months: duration, total_units: total } = grant;

  // Period boundaries at or after the cliff, up to the full duration.
  const points: number[] = [];
  for (let m = step; m <= duration; m += step) {
    if (m >= cliff) points.push(m);
  }
  // A cliff that doesn't land on a period boundary is itself the first tranche.
  if (cliff > 0 && (points.length === 0 || points[0] > cliff)) points.unshift(cliff);
  if (points.length === 0) points.push(duration);
  if (points[points.length - 1] < duration) points.push(duration);

  const whole = Number.isInteger(total);
  const round = (n: number) => whole ? Math.round(n) : Math.round(n * 1e6) / 1e6;

  const out: PlannedVest[] = [];
  let cumulative = 0;
  points.forEach((month, i) => {
    const isLast = i === points.length - 1;
    const idealCum = isLast ? total : round(total * (month / duration));
    const units = round(idealCum - cumulative);
    if (units > 0) {
      out.push({ vest_date: addMonths(grant.grant_date, month), units });
      cumulative = round(cumulative + units);
    }
  });

  const drift = round(total - out.reduce((s, v) => s + v.units, 0));
  if (drift !== 0 && out.length > 0) {
    out[out.length - 1].units = round(out[out.length - 1].units + drift);
  }
  return out;
}

/** Write a grant's schedule. Existing rows for the grant are replaced. */
export function generateVestRows(db: Database.Database, grant: GrantRow): number {
  const planned = planVests(grant);
  const run = db.transaction(() => {
    db.prepare("DELETE FROM rsu_vests WHERE grant_id = ?").run(grant.id);
    const ins = db.prepare(
      "INSERT INTO rsu_vests (grant_id, vest_date, units, status) VALUES (?, ?, ?, 'scheduled')"
    );
    for (const p of planned) ins.run(grant.id, p.vest_date, p.units);
  });
  run();
  return planned.length;
}

/**
 * Flip every scheduled vest whose date has arrived to 'vested'. Idempotent:
 * only 'scheduled' rows are touched, so re-running changes nothing.
 */
export function markVested(db: Database.Database, asOf: IsoDate = today()): number {
  return db.prepare(
    "UPDATE rsu_vests SET status = 'vested' WHERE status = 'scheduled' AND vest_date <= ?"
  ).run(asOf).changes;
}

export interface ScheduleRow {
  grant_id: number;
  account_id: number;
  account_name: string;
  symbol: string;
  vest_id: number;
  vest_date: IsoDate;
  units: number;
  units_sold_to_cover_tax: number;
  net_units: number;
  price_at_vest_minor: number | null;
  status: VestStatus;
  currency: string;
}

export function schedule(db: Database.Database): ScheduleRow[] {
  return db.prepare(`
    SELECT g.id AS grant_id, g.account_id, a.name AS account_name, g.symbol, g.currency,
           v.id AS vest_id, v.vest_date, v.units, v.units_sold_to_cover_tax,
           (v.units - v.units_sold_to_cover_tax) AS net_units,
           v.price_at_vest_minor, v.status
    FROM rsu_vests v
    JOIN rsu_grants g ON g.id = v.grant_id
    JOIN accounts a   ON a.id = g.account_id
    ORDER BY v.vest_date, v.id
  `).all() as ScheduleRow[];
}
