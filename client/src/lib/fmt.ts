import type { Currency } from "@choopi/shared";

interface FmtOptions {
  currency?: Currency;
  decimals?: number;
  sign?: boolean;
}

export function fmt(n: number, opts: FmtOptions = {}): string {
  const { currency = "NIS", decimals = 0, sign = false } = opts;
  const sym = currency === "USD" ? "$" : "₪";
  const v = Math.abs(n).toLocaleString("en-US", {
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
