/**
 * RSU grants + vesting, manual-entry only.
 *
 * A grant hangs off a market-valued account (kind='rsu'). Each vesting event is
 * an editable row. When a vest date has passed AND you've entered the FMV for
 * that date, the event materializes into a 'buy' entry (source='vest') at that
 * FMV — which is your cost basis, since you're taxed on the value at vest. From
 * there the account values like any other holding: quantity × your latest price.
 *
 * Unvested units are reported but never counted in value or principal: they
 * aren't yours yet.
 *
 * FMV cannot be looked up (no external sources) — so an event whose date has
 * passed without an FMV is surfaced as "needs FMV" rather than silently skipped.
 */

import type Database from "better-sqlite3";
import { today } from "./valuation.js";

export type VestFrequency = "monthly" | "quarterly" | "annual";

export interface VestingRule {
  cliff_months: number;
  total_months: number;
  frequency: VestFrequency;
}

export interface GeneratedEvent {
  vest_on: string;
  units: number;
}

export interface VestingEventRow {
  id: number;
  grant_id: number;
  vest_on: string;
  units: number;
  fmv_at_vest: number | null;
  status: "scheduled" | "vested";
  entry_id: number | null;
}

const FREQUENCY_MONTHS: Record<VestFrequency, number> = { monthly: 1, quarterly: 3, annual: 12 };

/** grant date + n months, clamped to the last day of shorter months. */
function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const target = m - 1 + months;
  const ty = y + Math.floor(target / 12);
  const tm = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

/**
 * Turn a vesting rule into discrete events. Pre-cliff accrual lands in one
 * tranche at the cliff; whole-share grants get whole-share events; any rounding
 * remainder goes into the final event so units always sum to the grant exactly.
 */
export function generateVestingSchedule(
  grantDate: string,
  totalUnits: number,
  rule: VestingRule
): GeneratedEvent[] {
  const step = FREQUENCY_MONTHS[rule.frequency];
  const { cliff_months, total_months } = rule;

  const points: number[] = [];
  for (let m = step; m <= total_months; m += step) {
    if (m < cliff_months) continue;
    points.push(m);
  }
  if (cliff_months > 0 && (points.length === 0 || points[0] > cliff_months)) {
    points.unshift(cliff_months);
  }
  if (points.length === 0 || points[points.length - 1] < total_months) {
    points.push(total_months);
  }

  const whole = Number.isInteger(totalUnits);
  const round = (n: number) => whole ? Math.round(n) : Math.round(n * 1e6) / 1e6;

  const events: GeneratedEvent[] = [];
  let cumulative = 0;
  for (let i = 0; i < points.length; i++) {
    const isLast = i === points.length - 1;
    const idealCum = isLast ? totalUnits : round(totalUnits * (points[i] / total_months));
    const units = round(idealCum - cumulative);
    if (units > 0) {
      events.push({ vest_on: addMonths(grantDate, points[i]), units });
      cumulative = round(cumulative + units);
    }
  }
  const sum = events.reduce((s, e) => s + e.units, 0);
  const diff = round(totalUnits - sum);
  if (diff !== 0 && events.length > 0) {
    events[events.length - 1].units = round(events[events.length - 1].units + diff);
  }
  return events;
}

export interface VestingSummary {
  total_units: number;
  vested_units: number;
  unvested_units: number;
  /** Past-dated events still waiting on an FMV before they can become lots. */
  needs_fmv_units: number;
  next_vest: { vest_on: string; units: number } | null;
}

export function summarizeVesting(
  events: Pick<VestingEventRow, "vest_on" | "units" | "status" | "fmv_at_vest">[],
  asOf: string = today()
): VestingSummary {
  let vested = 0, unvested = 0, needsFmv = 0;
  let next: { vest_on: string; units: number } | null = null;

  for (const e of events) {
    const due = e.vest_on.slice(0, 10) <= asOf;
    if (e.status === "vested") {
      vested += e.units;
    } else if (due) {
      // Date has passed but it isn't a lot yet — counts as vested for the split,
      // and flagged so the UI can ask for the FMV.
      vested += e.units;
      if (e.fmv_at_vest == null) needsFmv += e.units;
    } else {
      unvested += e.units;
      if (!next || e.vest_on < next.vest_on) next = { vest_on: e.vest_on.slice(0, 10), units: e.units };
    }
  }

  return {
    total_units: vested + unvested,
    vested_units: vested,
    unvested_units: unvested,
    needs_fmv_units: needsFmv,
    next_vest: next,
  };
}

export interface GrantRow {
  id: number;
  account_id: number;
  user_id: number;
}

export interface MaterializeResult {
  vested: number;
  needs_fmv: number;
}

/**
 * Post a 'buy' entry for every event that has vested and has an FMV.
 * Idempotent: only 'scheduled' rows are considered, and each becomes at most one
 * entry (tracked by entry_id).
 */
export function materializeVested(
  db: Database.Database,
  grant: GrantRow,
  asOf: string = today()
): MaterializeResult {
  const due = db.prepare(
    `SELECT * FROM rsu_vesting_events
     WHERE grant_id = ? AND status = 'scheduled' AND substr(vest_on, 1, 10) <= ?
     ORDER BY vest_on ASC, id ASC`
  ).all(grant.id, asOf) as VestingEventRow[];

  let vested = 0, needs_fmv = 0;

  const run = db.transaction(() => {
    for (const e of due) {
      if (e.fmv_at_vest == null || e.fmv_at_vest <= 0) { needs_fmv++; continue; }
      const entryId = db.prepare(
        `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, quantity,
                              price_per_unit, source, note)
         VALUES (?, ?, 'buy', ?, ?, ?, ?, 'vest', 'RSU vest')`
      ).run(
        grant.account_id, grant.user_id, e.vest_on.slice(0, 10),
        e.units * e.fmv_at_vest, e.units, e.fmv_at_vest
      ).lastInsertRowid as number;

      db.prepare(
        "UPDATE rsu_vesting_events SET status = 'vested', entry_id = ? WHERE id = ?"
      ).run(entryId, e.id);
      vested++;
    }
  });
  run();

  return { vested, needs_fmv };
}

/**
 * Reflect an edited vesting event onto its posted entry. Moving a vested event
 * into the future un-posts it (the units aren't yours yet).
 */
export function syncVestedEntry(
  db: Database.Database,
  event: VestingEventRow,
  asOf: string = today()
): void {
  if (event.status !== "vested" || event.entry_id == null) return;

  if (event.vest_on.slice(0, 10) > asOf) {
    db.transaction(() => {
      db.prepare("DELETE FROM entries WHERE id = ?").run(event.entry_id);
      db.prepare(
        "UPDATE rsu_vesting_events SET status = 'scheduled', entry_id = NULL WHERE id = ?"
      ).run(event.id);
    })();
    return;
  }

  db.prepare(
    `UPDATE entries SET occurred_on = ?, quantity = ?, price_per_unit = ?, amount = ?
     WHERE id = ?`
  ).run(
    event.vest_on.slice(0, 10), event.units, event.fmv_at_vest,
    event.units * (event.fmv_at_vest ?? 0), event.entry_id
  );
}
