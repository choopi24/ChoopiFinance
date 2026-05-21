/**
 * Portfolio snapshot helper.
 * Captures current portfolio value into portfolio_snapshots.
 * Called on every BUY/SELL/UPDATE transaction and by the daily cron job.
 */

import type Database from "better-sqlite3";
import { computePortfolio } from "./portfolio.js";
import { getRateSync } from "./fx.js";

export function takeSnapshot(db: Database.Database, userId: number): void {
  try {
    const summary = computePortfolio(db, userId);
    const fx = getRateSync(db, userId);
    const total_value_usd = fx.rate > 0 ? summary.total_value_nis / fx.rate : 0;
    const total_net_deposited_usd = fx.rate > 0 ? summary.total_net_deposited_nis / fx.rate : 0;

    db.prepare(
      `INSERT INTO portfolio_snapshots
         (user_id, total_value_nis, total_value_usd, total_net_deposited_nis, total_net_deposited_usd)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      userId,
      summary.total_value_nis,
      total_value_usd,
      summary.total_net_deposited_nis,
      total_net_deposited_usd
    );
  } catch (err) {
    // Snapshots are best-effort — never crash a transaction for this
    console.error("Snapshot error for user", userId, (err as Error).message);
  }
}
