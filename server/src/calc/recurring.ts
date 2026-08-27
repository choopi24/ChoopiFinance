/**
 * Recurring-rule engine — the salary-funded deposits.
 *
 * Idempotency is guaranteed two independent ways, because double-posting money
 * is the worst failure this module could have:
 *
 *   1. A WATERMARK. Each rule carries `last_generated_date`; generation only
 *      ever looks at dates strictly after it, then advances it. This is what
 *      makes DELETION STICK: once the watermark has passed a date, that date is
 *      never revisited, so a generated transaction you deleted stays deleted.
 *   2. A UNIQUE INDEX on (recurring_rule_id, date). Even if the watermark were
 *      wrong, the database itself refuses a second posting for the same rule and
 *      day — the insert is `OR IGNORE`, so it is skipped rather than throwing.
 *
 * Generated rows are ordinary transactions (source='recurring'): fully editable
 * and deletable like any other.
 */

import type Database from "better-sqlite3";
import { dayInMonth, today, type IsoDate } from "./dates.js";

const PERIOD_MONTHS = { monthly: 1, quarterly: 3, annual: 12 } as const;

export interface RuleRow {
  id: number;
  account_id: number;
  label: string | null;
  frequency: keyof typeof PERIOD_MONTHS;
  day_of_month: number;
  amount_minor: number;
  currency: string;
  contribution_part: string | null;
  start_date: IsoDate;
  end_date: IsoDate | null;
  auto_generate: number;
  last_generated_date: IsoDate | null;
  is_active: number;
}

/**
 * Every date a rule should post on, within [from, to]. `from` excludes the
 * watermark itself so a date is never generated twice.
 */
export function dueDates(rule: RuleRow, upTo: IsoDate): IsoDate[] {
  const step = PERIOD_MONTHS[rule.frequency] ?? 1;
  const lastDate = rule.end_date && rule.end_date < upTo ? rule.end_date : upTo;
  const after = rule.last_generated_date;

  const out: IsoDate[] = [];
  let y = Number(rule.start_date.slice(0, 4));
  let m = Number(rule.start_date.slice(5, 7));

  // Anchor the cycle on the rule's start month so quarterly/annual land on the
  // same months every year rather than drifting with the run date.
  let guard = 0;
  while (guard++ < 1200) {
    const when = dayInMonth(y, m, rule.day_of_month);
    if (when > lastDate) break;
    if (when >= rule.start_date && (after == null || when > after)) out.push(when);
    m += step;
    while (m > 12) { m -= 12; y += 1; }
  }
  return out;
}

export interface GenerateResult {
  created: number;
  rules_considered: number;
  by_rule: { rule_id: number; label: string | null; created: number; dates: IsoDate[] }[];
}

/**
 * Post everything active rules owe up to `asOf`. Safe to call on every boot and
 * on a daily schedule.
 */
export function generateDue(db: Database.Database, asOf: IsoDate = today()): GenerateResult {
  const rules = db.prepare(
    `SELECT * FROM recurring_rules
     WHERE is_active = 1 AND auto_generate = 1 AND start_date <= ?
     ORDER BY id`
  ).all(asOf) as RuleRow[];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO transactions
       (account_id, date, type, amount_minor, contribution_part, currency, source,
        recurring_rule_id, note)
     VALUES (?, ?, 'deposit', ?, ?, ?, 'recurring', ?, ?)`
  );
  const bump = db.prepare("UPDATE recurring_rules SET last_generated_date = ? WHERE id = ?");

  const result: GenerateResult = { created: 0, rules_considered: rules.length, by_rule: [] };

  const run = db.transaction(() => {
    for (const rule of rules) {
      const dates = dueDates(rule, asOf);
      let created = 0;
      for (const date of dates) {
        created += insert.run(
          rule.account_id, date, rule.amount_minor, rule.contribution_part,
          rule.currency, rule.id, rule.label ?? "Recurring deposit"
        ).changes;
      }
      // Advance the watermark even when nothing was created (e.g. the rows were
      // deleted by hand) — that is precisely what stops regeneration.
      const newWatermark = dates.length ? dates[dates.length - 1] : rule.last_generated_date;
      if (newWatermark && newWatermark !== rule.last_generated_date) bump.run(newWatermark, rule.id);
      result.created += created;
      if (dates.length) result.by_rule.push({ rule_id: rule.id, label: rule.label, created, dates });
    }
  });
  run();

  return result;
}

export interface UpcomingPosting {
  rule_id: number;
  account_id: number;
  account_name: string;
  label: string | null;
  date: IsoDate;
  amount_minor: number;
  currency: string;
  contribution_part: string | null;
}

/**
 * What WOULD be posted next, without posting it. Looks forward from `asOf`,
 * ignoring the watermark (which only governs the past).
 */
export function previewUpcoming(
  db: Database.Database,
  asOf: IsoDate = today(),
  horizonMonths = 3
): UpcomingPosting[] {
  const rules = db.prepare(
    `SELECT r.*, a.name AS account_name FROM recurring_rules r
     JOIN accounts a ON a.id = r.account_id
     WHERE r.is_active = 1 ORDER BY r.id`
  ).all() as (RuleRow & { account_name: string })[];

  const horizon = (() => {
    const [y, m, d] = asOf.split("-").map(Number);
    const t = m - 1 + horizonMonths;
    const ty = y + Math.floor(t / 12);
    const tm = ((t % 12) + 12) % 12;
    return dayInMonth(ty, tm + 1, d);
  })();

  const out: UpcomingPosting[] = [];
  for (const rule of rules) {
    // Look ahead only: treat everything up to today as already handled.
    const future = dueDates({ ...rule, last_generated_date: asOf }, horizon);
    for (const date of future) {
      out.push({
        rule_id: rule.id,
        account_id: rule.account_id,
        account_name: rule.account_name,
        label: rule.label,
        date,
        amount_minor: rule.amount_minor,
        currency: rule.currency,
        contribution_part: rule.contribution_part,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
