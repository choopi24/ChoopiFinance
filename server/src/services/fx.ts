/**
 * FX rate service — USD/NIS via Frankfurter (free, no key).
 * 15-minute TTL cached in fx_cache table.
 * User-level manual override stored in users.fx_override takes precedence.
 *
 * Frankfurter uses "ILS" (ISO 4217) for the Israeli Shekel; we normalise to
 * the app's internal "NIS" label on the way in/out.
 */

import type Database from "better-sqlite3";

const FX_TTL_MS = 15 * 60 * 1_000;
const FALLBACK_USD_NIS = 3.7;
const FRANKFURTER_URL = "https://api.frankfurter.app/latest?from=USD&to=ILS";

export interface FxResult {
  rate: number;
  source: "override" | "cached" | "fallback";
  fetched_at: string | null;
  override: number | null;
}

// ── Internal: fetch from Frankfurter and update cache ────────────────────────

async function fetchAndCache(db: Database.Database): Promise<number> {
  const resp = await fetch(FRANKFURTER_URL, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) throw new Error(`Frankfurter HTTP ${resp.status}`);
  const json = await resp.json() as { rates?: { ILS?: number } };
  const rate = json.rates?.ILS;
  if (!rate || typeof rate !== "number") throw new Error("Unexpected Frankfurter response");

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO fx_cache (pair, rate, fetched_at) VALUES ('USD_NIS', ?, ?)`
  ).run(rate, now);

  return rate;
}

// ── Check if cache is fresh ──────────────────────────────────────────────────

function getCached(db: Database.Database): { rate: number; fetched_at: string } | null {
  const row = db
    .prepare<[], { rate: number; fetched_at: string }>(
      "SELECT rate, fetched_at FROM fx_cache WHERE pair = 'USD_NIS'"
    )
    .get();
  if (!row) return null;
  const age = Date.now() - new Date(row.fetched_at).getTime();
  return age < FX_TTL_MS ? row : null; // null = stale
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return USD→NIS rate. Checks in order:
 *   1. User's manual override (if userId provided)
 *   2. Fresh cache (< 15 min)
 *   3. Fetch Frankfurter and cache
 *   4. Stale cache (better than fallback)
 *   5. Hardcoded fallback
 */
export async function getRate(
  db: Database.Database,
  userId?: number
): Promise<FxResult> {
  // 1. User override
  if (userId != null) {
    const user = db
      .prepare<[number], { fx_override: number | null }>(
        "SELECT fx_override FROM users WHERE id = ?"
      )
      .get(userId);
    if (user?.fx_override != null) {
      return {
        rate: user.fx_override,
        source: "override",
        fetched_at: null,
        override: user.fx_override,
      };
    }
  }

  // 2. Fresh cache
  const cached = getCached(db);
  if (cached) {
    return { rate: cached.rate, source: "cached", fetched_at: cached.fetched_at, override: null };
  }

  // 3. Fetch live
  try {
    const rate = await fetchAndCache(db);
    const fetched_at = new Date().toISOString();
    return { rate, source: "cached", fetched_at, override: null };
  } catch {
    // 4. Stale cache fallback
    const stale = db
      .prepare<[], { rate: number; fetched_at: string }>(
        "SELECT rate, fetched_at FROM fx_cache WHERE pair = 'USD_NIS'"
      )
      .get();
    if (stale) return { rate: stale.rate, source: "cached", fetched_at: stale.fetched_at, override: null };

    // 5. Hardcoded
    return { rate: FALLBACK_USD_NIS, source: "fallback", fetched_at: null, override: null };
  }
}

/**
 * Synchronous version — for portfolio computations that can't be async.
 * Reads cache only (no network call). Falls back to hardcoded 3.7.
 * Call getRate() first to warm the cache.
 */
export function getRateSync(db: Database.Database, userId?: number): FxResult {
  if (userId != null) {
    const user = db
      .prepare<[number], { fx_override: number | null }>("SELECT fx_override FROM users WHERE id = ?")
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
