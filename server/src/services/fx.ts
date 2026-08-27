/**
 * FX conversion — LOCAL ONLY. No provider, no network.
 *
 * Rates are read from the fx_cache table, which is now written by hand rather
 * than by a feed (the Frankfurter integration was removed). Conversion helpers
 * and call signatures are unchanged so every consumer keeps working.
 *
 * Interim behaviour until manual FX entry lands with the new schema: with no row
 * in fx_cache, callers get FALLBACK_USD_NIS and `source: "fallback"`, which the
 * client already surfaces as an approximation. A dated rate series with
 * carry-forward replaces this in the schema step.
 *
 * The app internally labels the shekel "NIS"; a rename to ISO "ILS" belongs to
 * the schema step, not here.
 */

import type Database from "better-sqlite3";

/** Used only when no rate has been entered yet. Flagged as `source: "fallback"`. */
export const FALLBACK_USD_NIS = 3.7;

/** Convert a native amount to NIS using a USD→NIS rate. NIS passes through. */
export function toNis(amount: number, currency: string, usdNis: number): number {
  return currency === "NIS" ? amount : amount * usdNis;
}

export interface FxResult {
  rate: number;
  source: "override" | "cached" | "fallback";
  fetched_at: string | null;
  override: number | null;
}

/**
 * Resolve the USD→NIS rate from local data only, in order:
 *   1. the user's manual override (users.fx_override)
 *   2. the stored fx_cache row (no staleness check — a hand-entered rate does
 *      not expire, and there is nothing to refresh it from)
 *   3. FALLBACK_USD_NIS
 */
export function getRateSync(db: Database.Database, userId?: number): FxResult {
  if (userId != null) {
    const user = db
      .prepare<[number], { fx_override: number | null }>(
        "SELECT fx_override FROM users WHERE id = ?"
      )
      .get(userId);
    if (user?.fx_override != null) {
      return { rate: user.fx_override, source: "override", fetched_at: null, override: user.fx_override };
    }
  }

  const row = db
    .prepare<[], { rate: number; fetched_at: string }>(
      "SELECT rate, fetched_at FROM fx_cache WHERE pair = 'USD_NIS'"
    )
    .get();

  return row
    ? { rate: row.rate, source: "cached", fetched_at: row.fetched_at, override: null }
    : { rate: FALLBACK_USD_NIS, source: "fallback", fetched_at: null, override: null };
}

/**
 * Async wrapper kept so existing callers (routes/fx.ts) need no change. There is
 * nothing to await any more — it simply defers to the synchronous local read.
 */
export async function getRate(db: Database.Database, userId?: number): Promise<FxResult> {
  return getRateSync(db, userId);
}

/**
 * Record a USD→NIS rate manually. The only writer of fx_cache now that the
 * provider is gone.
 */
export function setRate(db: Database.Database, rate: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO fx_cache (pair, rate, fetched_at) VALUES ('USD_NIS', ?, ?)"
  ).run(rate, new Date().toISOString());
}
