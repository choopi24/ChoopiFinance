export type AssetType = "crypto" | "stock" | "etf" | "pension" | "education" | "other";
export type Currency = "NIS" | "USD";
// "UPDATE" is the canonical DB value; "UPD" kept for display abbreviation compatibility
export type TransactionKind = "BUY" | "SELL" | "DIV" | "UPDATE" | "UPD";
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
  created_at: string;
}

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
