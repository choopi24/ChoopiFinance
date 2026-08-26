/**
 * Shared input validation for the v2 API. Pure functions, no Express —
 * every route validates before touching SQL so a bad value surfaces as a clear
 * 400 rather than a raw SQLite CHECK-constraint 500.
 */

export type Result<T> = { value: T } | { error: string };
export const isErr = <T>(r: Result<T>): r is { error: string } => "error" in r;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CURRENCIES = ["ILS", "USD"] as const;
export const ACCOUNT_KINDS = [
  "stock", "etf", "crypto", "rsu",
  "keren_hishtalmut", "pension", "gemel_lehashkaa", "other",
] as const;
export const VALUATION_MODES = ["market", "balance"] as const;
export const FUNDING_MODES = ["manual", "salary", "passive"] as const;
export const ENTRY_KINDS = ["deposit", "withdrawal", "buy", "sell", "balance", "fee"] as const;
export const FEE_KINDS = ["deposit", "balance", "other"] as const;

/** Which ledger kinds each valuation mode accepts. */
export const KINDS_FOR_MODE: Record<string, readonly string[]> = {
  market:  ["buy", "sell", "fee"],
  balance: ["deposit", "withdrawal", "balance", "fee"],
};

export function date(raw: unknown, field: string): Result<string> {
  const s = String(raw ?? "").slice(0, 10);
  if (!ISO_DATE.test(s) || isNaN(new Date(`${s}T00:00:00Z`).getTime())) {
    return { error: `${field} must be a date in YYYY-MM-DD form` };
  }
  return { value: s };
}

export function nonEmpty(raw: unknown, field: string): Result<string> {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return { error: `${field} is required` };
  return { value: s };
}

export function positive(raw: unknown, field: string): Result<number> {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n) || n <= 0) {
    return { error: `${field} must be a number greater than zero` };
  }
  return { value: n };
}

export function nonNegative(raw: unknown, field: string): Result<number> {
  const n = Number(raw);
  if (raw == null || raw === "" || !Number.isFinite(n) || n < 0) {
    return { error: `${field} must be zero or more` };
  }
  return { value: n };
}

/** Optional number: null/"" clears it; otherwise must be within [min, max]. */
export function optionalPct(raw: unknown, field: string, max = 100): Result<number | null> {
  if (raw == null || raw === "") return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    return { error: `${field} must be between 0 and ${max}` };
  }
  return { value: n };
}

export function oneOf<T extends string>(
  raw: unknown, allowed: readonly T[], field: string
): Result<T> {
  const s = String(raw ?? "");
  if (!allowed.includes(s as T)) {
    return { error: `${field} must be one of: ${allowed.join(", ")}` };
  }
  return { value: s as T };
}

/** Normalizes a symbol the way the price series keys it: trimmed + uppercased. */
export function symbol(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  return s || null;
}
