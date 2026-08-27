/** Row shapes as stored, plus the calc layer's output shapes. */

import type { IsoDate } from "./dates.js";

export type Currency = "ILS" | "USD";
export type ValuationMode = "market" | "balance";
export type FundingMode = "manual" | "salary" | "passive";
export type TxType =
  | "deposit" | "withdrawal" | "buy" | "sell" | "fee" | "dividend" | "adjustment";
export type FeeKind = "management_balance" | "management_deposit" | "trade" | "other";
export type ContributionPart = "employee" | "employer" | "severance";
export type VestStatus = "scheduled" | "vested" | "cancelled";

export interface AccountRow {
  id: number;
  name: string;
  institution: string | null;
  category: string;
  valuation_mode: ValuationMode;
  currency: Currency;
  funding_mode: FundingMode;
  mgmt_fee_balance_pct: number | null;
  mgmt_fee_deposit_pct: number | null;
  is_active: number;
  notes: string | null;
}

export interface HoldingRow {
  id: number;
  account_id: number;
  symbol: string;
  display_name: string | null;
  asset_class: string;
  currency: Currency;
}

export interface PriceRow {
  holding_id: number;
  date: IsoDate;
  price_minor: number;
  currency: Currency;
}

export interface TxRow {
  id: number;
  account_id: number;
  holding_id: number | null;
  date: IsoDate;
  type: TxType;
  amount_minor: number;
  quantity: number | null;
  price_minor: number | null;
  contribution_part: ContributionPart | null;
  fee_kind: FeeKind | null;
  currency: Currency;
  source: "manual" | "recurring";
  recurring_rule_id: number | null;
}

export interface ValuationRow {
  account_id: number;
  date: IsoDate;
  balance_minor: number;
  currency: Currency;
}

export interface FxRow {
  date: IsoDate;
  base_currency: Currency;
  quote_currency: Currency;
  rate: number;
}

export interface GrantRow {
  id: number;
  account_id: number;
  symbol: string;
  grant_date: IsoDate;
  total_units: number;
  grant_price_minor: number | null;
  currency: Currency;
  cliff_months: number;
  vest_duration_months: number;
  vest_frequency: "monthly" | "quarterly" | "annual";
}

export interface VestRow {
  id: number;
  grant_id: number;
  vest_date: IsoDate;
  units: number;
  price_at_vest_minor: number | null;
  units_sold_to_cover_tax: number;
  status: VestStatus;
}

/** Everything the engine needs, loaded once. */
export interface Ledger {
  accounts: AccountRow[];
  holdings: HoldingRow[];
  prices: PriceRow[];
  transactions: TxRow[];
  valuations: ValuationRow[];
  fx: FxRow[];
  grants: GrantRow[];
  vests: VestRow[];
}

/** How an RSU vest contributes to net principal. */
export type RsuPrincipalBasis = "zero_cost" | "vest_price";

export interface CalcOptions {
  /** Default 'zero_cost': vested shares cost you nothing out of pocket. */
  rsuPrincipalBasis: RsuPrincipalBasis;
  /** A carried-forward rate older than this is flagged stale (days). */
  staleFxDays: number;
  /** A price/balance older than this marks the account stale. */
  staleDataDays: number;
}

export const DEFAULT_OPTIONS: CalcOptions = {
  rsuPrincipalBasis: "zero_cost",
  staleFxDays: 45,
  staleDataDays: 45,
};

/** Non-fatal conditions the client must be able to show rather than trust blindly. */
export type CalcFlag = "no_data" | "missing_fx" | "stale_fx" | "stale_data" | "missing_price";

export interface AccountSummary {
  account_id: number;
  name: string;
  category: string;
  valuation_mode: ValuationMode;
  funding_mode: FundingMode;
  currency: Currency;
  as_of: IsoDate;

  /** In the account's own currency. */
  value_minor: number;
  net_principal_minor: number;
  net_earnings_minor: number;
  gross_earnings_minor: number;
  fees_paid_minor: number;
  /** Derived from the fee percentages — a sanity check, never authoritative. */
  fees_estimated_minor: number;

  /** Same figures in the requested display currency. */
  display_currency: Currency;
  value_display_minor: number;
  net_principal_display_minor: number;
  net_earnings_display_minor: number;
  gross_earnings_display_minor: number;
  fees_paid_display_minor: number;
  fees_estimated_display_minor: number;
  fx_rate_used: number;

  simple_return_pct: number | null;
  money_weighted_return_pct: number | null;

  /** Market-mode detail. */
  holdings_value_minor: number;
  cash_minor: number;
  /** RSU units vested but reported separately from value when unvested. */
  unvested_units: number;
  vested_units: number;

  last_data_date: IsoDate | null;
  /** True for balance accounts: the statement figure already has fees removed. */
  balance_is_net_of_fees: boolean;
  flags: CalcFlag[];
}

export interface SeriesPoint {
  date: IsoDate;
  value_minor: number;
  principal_minor: number;
  earnings_minor: number;
  fees_minor: number;
}
