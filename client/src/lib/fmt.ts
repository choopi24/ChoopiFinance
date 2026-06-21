import type { Currency } from "@choopi/shared";

interface FmtOptions {
  currency?: Currency;
  decimals?: number;
  sign?: boolean;
}

/**
 * Pick a sensible decimal count by magnitude when none is given:
 * large fiat totals stay whole, while small/crypto values keep precision
 * (e.g. ₪487,320 → no decimals; $0.42 → $0.4200; $12.50 → $12.50).
 */
function autoDecimals(abs: number): number {
  if (abs === 0) return 0;
  if (abs < 1) return 4;
  if (abs < 100) return 2;
  return 0;
}

export function fmt(n: number, opts: FmtOptions = {}): string {
  const { currency = "NIS", sign = false } = opts;
  const abs = Math.abs(n);
  const decimals = opts.decimals ?? autoDecimals(abs);
  const sym = currency === "USD" ? "$" : "₪";
  const v = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const prefix = sign ? (n >= 0 ? "+" : "−") : n < 0 ? "−" : "";
  return `${prefix}${sym}${v}`;
}

export function pct(n: number, opts: { sign?: boolean; decimals?: number } = {}): string {
  const { sign = true, decimals = 2 } = opts;
  return `${sign ? (n >= 0 ? "+" : "−") : ""}${Math.abs(n).toFixed(decimals)}%`;
}
