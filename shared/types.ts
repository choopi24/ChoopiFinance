// Israeli regulated funds: pension = קרן פנסיה, gemel = קופת גמל,
// education = קרן השתלמות, money_market = קרן כספית.
export type AssetType =
  | "crypto" | "stock" | "etf"
  | "pension" | "gemel" | "education" | "money_market" | "other";

/** Manual (non-market) types: value tracked via UPDATE balance snapshots. */
export const MANUAL_ASSET_TYPES: readonly AssetType[] =
  ["pension", "gemel", "education", "money_market", "other"];

/** Human-readable labels for asset types (used in filters, allocation, pills). */
export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  crypto: "Crypto",
  stock: "Stocks",
  etf: "ETFs",
  pension: "Pension",
  gemel: "Gemel",
  education: "Study fund",
  money_market: "Money market",
  other: "Other",
};
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
  type: AssetType;
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
  /** Gemel-Net / Pensia-Net fund id (Israeli regulated funds). */
  fund_id?: number | null;
  /** Fund track name (מסלול), e.g. "מסלול מניות". */
  fund_track?: string | null;
  /** Personal management fee on deposits (percent, e.g. 1.5 = 1.5%). */
  fee_deposit_pct?: number | null;
  /** Personal management fee on balance (percent per year, e.g. 0.6). */
  fee_balance_pct?: number | null;
  created_at: string;
}

/**
 * Per-type fallback annual returns (decimal) used for future-value projection
 * when an investment's expected_annual_return is null.
 */
export const DEFAULT_ANNUAL_RETURNS: Record<AssetType, number> = {
  pension:      0.04,
  gemel:        0.05,
  education:    0.04,
  money_market: 0.04,
  etf:          0.07,
  stock:        0.08,
  crypto:       0.10,
  other:        0.05,
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
