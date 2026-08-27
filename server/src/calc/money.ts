/**
 * Money helpers. Every monetary value in this app is an INTEGER of minor units
 * (agorot for ILS, cents for USD). Nothing here ever produces a fractional
 * currency amount: conversions round once, at the boundary.
 */

/** Minor units are integers; this is the only rounding gate they pass through. */
export const toMinor = (major: number): number => Math.round(major * 100);
export const toMajor = (minor: number): number => minor / 100;

/**
 * Multiply a minor-unit amount by a ratio (an FX rate, a fee percentage) and
 * return minor units again. Rounds half-away-from-zero so a negative amount
 * rounds symmetrically with its positive twin — otherwise a fee and its
 * reversal would not cancel.
 */
export function scaleMinor(minor: number, ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  const v = minor * ratio;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** Percentage of an amount, in minor units. `pct` is 0.62 for 0.62 %. */
export const pctOfMinor = (minor: number, pct: number): number =>
  scaleMinor(minor, pct / 100);

/**
 * A ratio that must never reach the client as NaN or Infinity.
 * Returns null when the denominator makes the answer meaningless.
 */
export function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Percentage form of safeRatio, rounded to 4 decimals. */
export function safePct(numerator: number, denominator: number): number | null {
  const r = safeRatio(numerator, denominator);
  return r == null ? null : Math.round(r * 1_000_000) / 10_000;
}
