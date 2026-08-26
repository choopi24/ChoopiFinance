/**
 * Daily portfolio snapshot.
 *
 * The history chart does NOT depend on these rows — /api/portfolio/history
 * recomputes the decomposition from the ledger on demand, so back-dating an
 * entry corrects the past instead of leaving a stale series behind. Snapshots
 * are a cheap audit trail: what the numbers looked like on a given day, with
 * the prices and FX rates that were entered at the time.
 */

import type Database from "better-sqlite3";
import { computePortfolio, today, type Currency } from "./valuation.js";

export function takeSnapshot(db: Database.Database, userId: number, on: string = today()): void {
  try {
    const user = db.prepare("SELECT display_currency FROM users WHERE id = ?")
      .get(userId) as { display_currency: Currency } | undefined;
    const ccy: Currency = user?.display_currency === "USD" ? "USD" : "ILS";

    const p = computePortfolio(db, userId, ccy, on);

    db.prepare(
      `INSERT INTO portfolio_snapshots
         (user_id, currency, value, principal, gross_earnings, fees, snapshot_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, snapshot_on) DO UPDATE SET
         currency = excluded.currency, value = excluded.value,
         principal = excluded.principal, gross_earnings = excluded.gross_earnings,
         fees = excluded.fees`
    ).run(userId, ccy, p.value, p.principal, p.gross_earnings, p.fees, on);
  } catch (err) {
    // Snapshots are best-effort bookkeeping — never fail a user action for one.
    console.error("[snapshot] user", userId, (err as Error).message);
  }
}
