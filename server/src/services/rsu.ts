/**
 * RSU grant + vesting engine.
 *
 * A grant is 1:1 with an investments row (type='rsu'). Vesting events are
 * discrete, user-editable rows. When an event's vest_date arrives AND it has a
 * cost basis (fmv_at_vest — fetched historical close, or manually entered),
 * it "materializes": a BUY transaction is inserted (units × fmv) and linked
 * via transaction_id. From there the existing FIFO / pricing / FX / realized
 * engines treat vested RSUs exactly like any other market lot. Only vested
 * units count toward net worth; unvested units are reporting-only.
 *
 * Pure schedule math lives in generateVestingSchedule / summarizeVesting so it
 * can be unit-tested without a DB. Materialization takes an injectable quote
 * function for the same reason.
 */

import type Database from "better-sqlite3";
import { recomputeRealized } from "./fifo.js";
import { getQuote } from "./quote.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type VestFrequency = "monthly" | "quarterly" | "annual";

export interface VestingRule {
  cliff_months: number;   // 0 = no cliff
  total_months: number;
  frequency: VestFrequency;
}

export interface GeneratedEvent {
  vest_date: string;      // YYYY-MM-DD
  units: number;
}

export interface VestingEventRow {
  id: number;
  grant_id: number;
  vest_date: string;
  units: number;
  fmv_at_vest: number | null;
  status: "scheduled" | "vested";
  transaction_id: number | null;
  created_at: string;
}

export interface VestingSummary {
  vested_units: number;
  unvested_units: number;
  /** Scheduled events dated <= today that haven't materialized (need FMV or a refresh). */
  due_units: number;
  next_vest_event: { vest_date: string; units: number } | null;
}

const FREQUENCY_MONTHS: Record<VestFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
};

// ── Schedule generation ───────────────────────────────────────────────────────

/** grant_date + n months, clamped to the last day of the target month (Jan 31 + 1mo → Feb 28). */
function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const targetMonth = m - 1 + months;
  const ty = y + Math.floor(targetMonth / 12);
  const tm = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const td = Math.min(d, lastDay);
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(td).padStart(2, "0")}`;
}

/**
 * Generate discrete vesting events from a rule.
 *
 * Vest points are every `frequency` months after grant_date up to total_months.
 * Points before the cliff are merged into one event at the cliff month (the
 * standard "N/total vests at cliff" shape). Whole-share grants get whole-share
 * events (largest-remainder via cumulative rounding); fractional grants keep
 * 6-decimal precision. Any rounding remainder lands in the final event so the
 * sum always equals total_units exactly.
 */
export function generateVestingSchedule(
  grantDate: string,
  totalUnits: number,
  rule: VestingRule
): GeneratedEvent[] {
  const step = FREQUENCY_MONTHS[rule.frequency];
  const { cliff_months, total_months } = rule;

  // Vest points in months-after-grant
  const points: number[] = [];
  for (let m = step; m <= total_months; m += step) {
    if (m < cliff_months) continue;           // accrues into the cliff event
    if (m === step && cliff_months > 0 && m < cliff_months) continue;
    points.push(m);
  }
  // If the cliff doesn't align with a step boundary, the first event is the cliff itself.
  if (cliff_months > 0 && (points.length === 0 || points[0] > cliff_months)) {
    points.unshift(cliff_months);
  }
  // Ensure the schedule ends at total_months (odd total/step combos).
  if (points.length === 0 || points[points.length - 1] < total_months) {
    points.push(total_months);
  }

  const wholeShares = Number.isInteger(totalUnits);
  const round = (n: number) => wholeShares ? Math.round(n) : Math.round(n * 1e6) / 1e6;

  const events: GeneratedEvent[] = [];
  let cumulative = 0;
  for (let i = 0; i < points.length; i++) {
    const isLast = i === points.length - 1;
    // Ideal cumulative fraction vested by this point = months / total_months.
    const idealCum = isLast ? totalUnits : round(totalUnits * (points[i] / total_months));
    const units = round(idealCum - cumulative);
    if (units > 0) {
      events.push({ vest_date: addMonths(grantDate, points[i]), units });
      cumulative = round(cumulative + units);
    }
  }
  // Guard: force exact total (float dust or all-rounded-to-zero edge).
  const sum = events.reduce((s, e) => s + e.units, 0);
  const diff = round(totalUnits - sum);
  if (diff !== 0 && events.length > 0) {
    events[events.length - 1].units = round(events[events.length - 1].units + diff);
  }
  return events;
}

// ── Vesting status ────────────────────────────────────────────────────────────

/** Compute vested/unvested/next-vest from event rows. `today` injectable for tests. */
export function summarizeVesting(
  events: Pick<VestingEventRow, "vest_date" | "units" | "status">[],
  today: string = new Date().toISOString().slice(0, 10)
): VestingSummary {
  let vested_units = 0;
  let unvested_units = 0;
  let due_units = 0;
  let next: { vest_date: string; units: number } | null = null;

  for (const e of events) {
    const dueByDate = e.vest_date.slice(0, 10) <= today;
    if (e.status === "vested") {
      vested_units += e.units;
    } else if (dueByDate) {
      // Past-dated but not yet materialized (missing FMV or refresh not run):
      // counts as vested for the split, flagged as due.
      vested_units += e.units;
      due_units += e.units;
    } else {
      unvested_units += e.units;
      if (!next || e.vest_date < next.vest_date) {
        next = { vest_date: e.vest_date.slice(0, 10), units: e.units };
      }
    }
  }

  return { vested_units, unvested_units, due_units, next_vest_event: next };
}

// ── Materialization: due events → BUY lots ────────────────────────────────────

export interface GrantRow {
  id: number;
  investment_id: number;
  user_id: number;
  symbol: string;
  currency: string;
}

/** Injectable historical-quote lookup (defaults to the Yahoo-backed quote service). */
export type FmvFetcher = (symbol: string, dateIso: string) =>
  Promise<{ price: number; currency: string } | null>;

const defaultFmvFetcher: FmvFetcher = async (symbol, dateIso) => {
  try {
    const q = await getQuote(symbol, "stock", dateIso);
    return { price: q.price, currency: q.currency };
  } catch {
    return null; // FMV stays null — user can enter it manually
  }
};

export interface MaterializeResult {
  vested: number;        // events materialized this run
  needs_fmv: number;     // due events still waiting for a cost basis
}

/**
 * Turn every due scheduled event (vest_date <= today) into a BUY lot.
 * Missing FMVs are fetched as the historical close on the vest date; if the
 * fetch fails the event stays 'scheduled' (flagged needs_fmv) until the user
 * enters a value or a later refresh succeeds. Never throws on fetch errors.
 */
export async function materializeDueEvents(
  db: Database.Database,
  grant: GrantRow,
  fetchFmv: FmvFetcher = defaultFmvFetcher,
  today: string = new Date().toISOString().slice(0, 10)
): Promise<MaterializeResult> {
  const due = db
    .prepare<[number, string], VestingEventRow>(
      `SELECT * FROM rsu_vesting_events
       WHERE grant_id = ? AND status = 'scheduled' AND substr(vest_date, 1, 10) <= ?
       ORDER BY vest_date ASC, id ASC`
    )
    .all(grant.id, today) as VestingEventRow[];

  let vested = 0;
  let needs_fmv = 0;

  for (const event of due) {
    let fmv = event.fmv_at_vest;
    let ccy = grant.currency;

    if (fmv == null) {
      const fetched = await fetchFmv(grant.symbol, event.vest_date.slice(0, 10));
      if (fetched && fetched.price > 0) {
        fmv = fetched.price;
        if (fetched.currency === "NIS" || fetched.currency === "USD") ccy = fetched.currency;
      }
    }

    if (fmv == null || fmv <= 0) {
      needs_fmv++;
      continue;
    }

    const vestOne = db.transaction(() => {
      const tx = db.prepare(
        `INSERT INTO transactions
           (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at, notes)
         VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?)`
      ).run(
        grant.investment_id, grant.user_id,
        event.units, fmv, event.units * fmv!, ccy,
        `${event.vest_date.slice(0, 10)}T12:00:00Z`,
        `RSU vest (${grant.symbol})`
      );
      db.prepare(
        `UPDATE rsu_vesting_events
         SET status = 'vested', fmv_at_vest = ?, transaction_id = ?
         WHERE id = ?`
      ).run(fmv, tx.lastInsertRowid, event.id);
    });
    vestOne();
    vested++;
  }

  if (vested > 0) recomputeRealized(db, grant.investment_id);
  return { vested, needs_fmv };
}

/**
 * Push an edit on a vesting event through to its materialized BUY (if any).
 * Un-vests (deletes the BUY) when the event is moved to a future date.
 */
export function syncEventTransaction(
  db: Database.Database,
  event: VestingEventRow,
  investmentId: number,
  today: string = new Date().toISOString().slice(0, 10)
): void {
  if (event.status !== "vested" || event.transaction_id == null) return;

  const backToFuture = event.vest_date.slice(0, 10) > today;
  if (backToFuture) {
    db.transaction(() => {
      db.prepare("DELETE FROM transactions WHERE id = ?").run(event.transaction_id);
      db.prepare(
        "UPDATE rsu_vesting_events SET status = 'scheduled', transaction_id = NULL WHERE id = ?"
      ).run(event.id);
    })();
  } else {
    db.prepare(
      `UPDATE transactions
       SET units = ?, price_per_unit = ?, total_amount = ?, occurred_at = ?
       WHERE id = ?`
    ).run(
      event.units,
      event.fmv_at_vest,
      event.units * (event.fmv_at_vest ?? 0),
      `${event.vest_date.slice(0, 10)}T12:00:00Z`,
      event.transaction_id
    );
  }
  recomputeRealized(db, investmentId);
}
