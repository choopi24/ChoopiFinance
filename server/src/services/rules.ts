/**
 * Recurring deposit rules — the engine behind salary-funded accounts
 * (pension, keren hishtalmut, gemel), where a fixed amount lands every month.
 *
 * Generation is idempotent two ways over: `INSERT OR IGNORE` plus a UNIQUE index
 * on (rule_id, occurred_on). Running it twice, or after editing history, can
 * never double-post a month — so it's safe to call on every boot, on a daily
 * cron, and on demand from the UI.
 */

import type Database from "better-sqlite3";
import { today } from "./valuation.js";

export interface DepositRule {
  id: number;
  account_id: number;
  user_id: number;
  amount: number;
  currency: string;
  day_of_month: number;
  start_on: string;
  end_on: string | null;
  active: number;
  note: string | null;
}

/** `day` clamped to a real date in that month (31 → 28/29/30 as needed). */
function clampDay(year: number, month1: number, day: number): string {
  const lastDay = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const d = Math.min(day, lastDay);
  return `${year}-${String(month1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface GenerateResult {
  created: number;
  rules_run: number;
}

/**
 * Post every deposit that a rule says should have landed by `asOf` and doesn't
 * exist yet. Returns how many rows were actually created.
 */
export function generateDueDeposits(
  db: Database.Database,
  userId: number,
  asOf: string = today()
): GenerateResult {
  const rules = db.prepare(
    `SELECT * FROM deposit_rules
     WHERE user_id = ? AND active = 1 AND start_on <= ?`
  ).all(userId, asOf) as DepositRule[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO entries
       (account_id, user_id, kind, occurred_on, amount, source, rule_id, note)
     VALUES (?, ?, 'deposit', ?, ?, 'rule', ?, ?)`
  );

  let created = 0;

  const run = db.transaction(() => {
    for (const rule of rules) {
      const lastDate = rule.end_on && rule.end_on < asOf ? rule.end_on : asOf;

      let y = Number(rule.start_on.slice(0, 4));
      let m = Number(rule.start_on.slice(5, 7));
      const endY = Number(lastDate.slice(0, 4));
      const endM = Number(lastDate.slice(5, 7));

      let guard = 0;
      while ((y < endY || (y === endY && m <= endM)) && guard++ < 1200) {
        const when = clampDay(y, m, rule.day_of_month);
        // The rule's own window still bounds each posting date.
        if (when >= rule.start_on && when <= lastDate) {
          const res = insert.run(
            rule.account_id, rule.user_id, when, rule.amount, rule.id,
            rule.note ?? "Monthly deposit"
          );
          created += res.changes;
        }
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    }
  });
  run();

  return { created, rules_run: rules.length };
}
