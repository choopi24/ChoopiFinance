/**
 * Management-fee tracking — hybrid model.
 *
 * Fees must be recorded explicitly, because a statement balance already has them
 * deducted: without fee rows the drag is invisible and silently counted as lost
 * earnings. But nobody wants to hand-enter a fee every month, and Israeli funds
 * only report דמי ניהול quarterly/annually. So:
 *
 *   1. ESTIMATES are accrued automatically from the account's configured rates
 *      (fee_deposit_pct on each deposit, fee_balance_annual_pct monthly on the
 *      balance). They carry is_estimate = 1 and source = 'accrual'.
 *   2. TRUE-UP: when you enter a real fee from a statement with a period, every
 *      estimate overlapping that period is suppressed. Real rows always win.
 *
 * Accrual is idempotent by construction: recompute wipes all estimates for the
 * account and regenerates them deterministically. Real (hand-entered) fee rows
 * are never touched.
 */

import type Database from "better-sqlite3";
import { accrualBaseAt, today, type AccountRow } from "./valuation.js";

/** Last calendar day of the month containing `date`. */
function monthEnd(year: number, month1: number): string {
  const d = new Date(Date.UTC(year, month1, 0)); // day 0 of next month = last of this
  return d.toISOString().slice(0, 10);
}

function monthStart(year: number, month1: number): string {
  return `${year}-${String(month1).padStart(2, "0")}-01`;
}

/** Inclusive list of {year, month} from `from` to `to` (YYYY-MM-DD bounds). */
function monthsBetween(from: string, to: string): { year: number; month1: number }[] {
  const out: { year: number; month1: number }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  // Guard against a pathological range walking forever.
  let guard = 0;
  while ((y < endY || (y === endY && m <= endM)) && guard++ < 1200) {
    out.push({ year: y, month1: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Does a hand-entered fee row already cover any part of [from, to]?
 * A row's covered range is [period_start, period_end] when given, else the day
 * it occurred on.
 */
function realFeeCovers(
  db: Database.Database,
  accountId: number,
  from: string,
  to: string
): boolean {
  const row = db.prepare(
    `SELECT 1 FROM entries
     WHERE account_id = ? AND kind = 'fee' AND is_estimate = 0
       AND COALESCE(period_start, occurred_on) <= ?
       AND COALESCE(period_end,   occurred_on) >= ?
     LIMIT 1`
  ).get(accountId, to, from);
  return row != null;
}

function firstActivityOn(db: Database.Database, accountId: number): string | null {
  const row = db.prepare(
    `SELECT MIN(occurred_on) AS first FROM entries
     WHERE account_id = ? AND kind <> 'fee'`
  ).get(accountId) as { first: string | null };
  return row.first;
}

export interface AccrualResult {
  deposit_fees: number;
  balance_fees: number;
  removed_estimates: number;
}

/**
 * Wipe and regenerate this account's fee estimates up to `asOf`.
 * Safe to call after any ledger change; never modifies real fee rows.
 */
export function recomputeAccruals(
  db: Database.Database,
  account: AccountRow,
  asOf: string = today()
): AccrualResult {
  const result: AccrualResult = { deposit_fees: 0, balance_fees: 0, removed_estimates: 0 };

  const run = db.transaction(() => {
    const wiped = db.prepare(
      "DELETE FROM entries WHERE account_id = ? AND kind = 'fee' AND is_estimate = 1"
    ).run(account.id);
    result.removed_estimates = wiped.changes;

    const insertFee = db.prepare(
      `INSERT INTO entries
         (account_id, user_id, kind, occurred_on, amount, source, fee_kind,
          is_estimate, period_start, period_end, note)
       VALUES (?, ?, 'fee', ?, ?, 'accrual', ?, 1, ?, ?, ?)`
    );

    // ── Fee on each deposit ───────────────────────────────────────────────────
    const depositPct = account.fee_deposit_pct ?? 0;
    if (depositPct > 0) {
      const deposits = db.prepare(
        `SELECT occurred_on, amount FROM entries
         WHERE account_id = ? AND kind = 'deposit' AND occurred_on <= ?
         ORDER BY occurred_on`
      ).all(account.id, asOf) as { occurred_on: string; amount: number }[];

      for (const d of deposits) {
        if (realFeeCovers(db, account.id, d.occurred_on, d.occurred_on)) continue;
        const fee = d.amount * (depositPct / 100);
        if (fee <= 0) continue;
        insertFee.run(
          account.id, account.user_id, d.occurred_on, fee, "deposit",
          d.occurred_on, d.occurred_on,
          `Estimated ${depositPct}% deposit fee`
        );
        result.deposit_fees++;
      }
    }

    // ── Monthly fee on balance ────────────────────────────────────────────────
    const annualPct = account.fee_balance_annual_pct ?? 0;
    const start = firstActivityOn(db, account.id);
    if (annualPct > 0 && start) {
      const monthlyRate = annualPct / 100 / 12;
      for (const { year, month1 } of monthsBetween(start, asOf)) {
        const mStart = monthStart(year, month1);
        const mEnd = monthEnd(year, month1);
        // Partial current month: charge up to today, not a future date.
        const chargeOn = mEnd > asOf ? asOf : mEnd;
        if (realFeeCovers(db, account.id, mStart, mEnd)) continue;

        const base = accrualBaseAt(db, account, chargeOn);
        const fee = base * monthlyRate;
        if (fee <= 0) continue;
        insertFee.run(
          account.id, account.user_id, chargeOn, fee, "balance",
          mStart, mEnd,
          `Estimated ${annualPct}%/yr balance fee`
        );
        result.balance_fees++;
      }
    }
  });
  run();

  return result;
}

/** Recompute accruals for every account of a user (e.g. after an FX/price change). */
export function recomputeAllAccruals(db: Database.Database, userId: number, asOf: string = today()): void {
  const accounts = db.prepare(
    "SELECT * FROM accounts WHERE user_id = ? AND archived_at IS NULL"
  ).all(userId) as AccountRow[];
  for (const a of accounts) recomputeAccruals(db, a, asOf);
}
