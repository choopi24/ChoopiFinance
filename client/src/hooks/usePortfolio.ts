import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { Currency } from "@choopi/shared";

export interface AllocationSlice {
  label: string;
  value_nis: number;
  pct: number;
}

export interface PortfolioSummary {
  total_value_nis: number;
  total_net_deposited_nis: number;
  unrealized_pl_nis: number;
  unrealized_pct: number | null;
  realized_ytd_nis: number;
  dividends_ytd_nis: number;
  allocation_by_type: AllocationSlice[];
  allocation_by_currency: AllocationSlice[];
  fx_rate_used: number;
  fx_source: "cached" | "fallback" | "override";
  investment_count: number;
}

export interface SnapshotPoint {
  snapshot_at: string;
  total_value_nis: number;
  total_value_usd: number;
  total_net_deposited_nis: number;
  total_net_deposited_usd: number;
}

interface ApiOk<T> { success: true; data: T }

export function usePortfolio() {
  return useQuery<PortfolioSummary>({
    queryKey: ["portfolio"],
    queryFn: () =>
      api.get<ApiOk<PortfolioSummary>>("/portfolio").then(r => r.data),
    staleTime: 5 * 60 * 1_000,
    refetchInterval: 5 * 60 * 1_000,
  });
}

export function usePortfolioHistory(range: "1M" | "3M" | "1Y" | "ALL" = "1Y") {
  return useQuery<{ range: string; snapshots: SnapshotPoint[] }>({
    queryKey: ["portfolio", "history", range],
    queryFn: () =>
      api.get<ApiOk<{ range: string; snapshots: SnapshotPoint[] }>>(
        `/portfolio/history?range=${range}`
      ).then(r => r.data),
    staleTime: 60 * 1_000,
  });
}

/** Convert a NIS portfolio value to the display currency. */
export function toDisplayCurrency(
  nisValue: number,
  currency: Currency,
  fxRate: number
): number {
  return currency === "USD" ? nisValue / fxRate : nisValue;
}
