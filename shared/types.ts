export type AssetType = "crypto" | "stock" | "etf" | "pension" | "education" | "other";
export type Currency = "NIS" | "USD";
// "UPDATE" = balance snapshot for manual types.
// "DEPOSIT" = actual cash contribution to education/other funds (for net-deposited P/L model).
// "UPD" kept for display abbreviation compatibility.
export type TransactionKind = "BUY" | "SELL" | "DIV" | "UPDATE" | "DEPOSIT" | "UPD";
export type Theme = "light" | "dark";
export type NavId = "dashboard" | "investments" | "transactions" | "realized" | "settings";

export interface User {
  id: number;
  username: string;
  display_currency: Currency;
  created_at: string;
}

export interface Investment {
  id: number;
  user_id: number;
  type: Exclude<AssetType, "stocks" | "edu">;
  name: string;
  ticker?: string;
  isin?: string;
  broker?: string;
  etf_kind?: "accumulating" | "distributing";
  liquid_date?: string;
  closed_at?: string;
  /** Expected monthly contribution amount (pension only). */
  monthly_deposit?: number | null;
  /** Currency of monthly_deposit (pension only). Defaults to 'NIS'. */
  deposit_currency?: string;
  /** Expected annual return as a decimal (e.g. 0.07 = 7%/yr). null → use DEFAULT_ANNUAL_RETURNS[type]. */
  expected_annual_return?: number | null;
  /** Recurring monthly contribution used in future-value projection. null/0 = none. */
  monthly_contribution?: number | null;
  created_at: string;
}

/**
 * Per-type fallback annual returns (decimal) used for future-value projection
 * when an investment's expected_annual_return is null.
 */
export const DEFAULT_ANNUAL_RETURNS: Record<AssetType, number> = {
  pension:   0.04,
  education: 0.04,
  etf:       0.07,
  stock:     0.08,
  crypto:    0.10,
  other:     0.05,
};

export interface Transaction {
  id: number;
  investment_id: number;
  user_id: number;
  kind: TransactionKind;
  units?: number;
  price_per_unit?: number;
  total_amount: number;
  currency: Currency;
  wallet_id?: number;
  occurred_at: string;
  notes?: string;
  realized_pl?: number;
  fx_rate_at_buy?: number;
  created_at: string;
}

export interface FxRate {
  pair: string;
  rate: number;
  fetched_at: string;
}

export interface ApiError {
  error: string;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
}
