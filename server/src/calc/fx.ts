/**
 * FX conversion from the manually-entered dated series.
 *
 * The rule everywhere: use the newest rate on-or-before the date (carry
 * forward). A rate is never invented — if none exists the amount passes through
 * unconverted and the caller gets `missing_fx` so the UI can say so. A rate
 * carried forward from long ago yields `stale_fx`.
 */

import { daysBetween, type IsoDate } from "./dates.js";
import type { Currency, FxRow } from "./types.js";

export interface FxResolution {
  rate: number;
  /** null when no conversion was needed. */
  rate_date: IsoDate | null;
  missing: boolean;
  stale: boolean;
}

/**
 * Resolve `from` → `to` for `date`. Accepts a rate stored in either direction:
 * a USD→ILS row also answers ILS→USD, inverted.
 */
export function resolveFx(
  fx: FxRow[],
  from: Currency,
  to: Currency,
  date: IsoDate,
  staleDays: number
): FxResolution {
  if (from === to) return { rate: 1, rate_date: null, missing: false, stale: false };

  let direct: FxRow | null = null;
  let inverse: FxRow | null = null;

  // Rows arrive sorted by date ascending; the last match wins (carry-forward).
  for (const r of fx) {
    if (r.date > date) break;
    if (r.base_currency === from && r.quote_currency === to) direct = r;
    else if (r.base_currency === to && r.quote_currency === from) inverse = r;
  }

  const chosen = direct ?? inverse;
  if (!chosen) return { rate: 1, rate_date: null, missing: true, stale: false };

  const rate = direct ? chosen.rate : 1 / chosen.rate;
  return {
    rate,
    rate_date: chosen.date,
    missing: false,
    stale: daysBetween(chosen.date, date) > staleDays,
  };
}
