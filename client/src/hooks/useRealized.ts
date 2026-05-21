import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface RealizedSummary {
  total: number;
  capital_gains: number;
  dividends: number;
  trade_count: number;
}

export interface RealizedByAsset {
  investment_id: number;
  name: string;
  ticker: string | null;
  type: string;
  realized: number;
  dividends: number;
  count: number;
}

export interface RealizedTransaction {
  id: number;
  investment_id: number;
  investment_name: string;
  investment_type: string;
  ticker: string | null;
  kind: "SELL" | "DIV";
  units: number | null;
  price_per_unit: number | null;
  total_amount: number;
  currency: string;
  occurred_at: string;
  realized_pl: number | null;
  notes: string | null;
}

export interface RealizedYear {
  year: number;
  total: number;
  capital_gains: number;
  dividends: number;
  count: number;
}

interface ApiOk<T> { success: true; data: T }

export function useRealizedYear(year: number) {
  return useQuery<{
    year: number;
    summary: RealizedSummary;
    by_asset: RealizedByAsset[];
    transactions: RealizedTransaction[];
  }>({
    queryKey: ["realized", year],
    queryFn: () =>
      api.get<ApiOk<any>>(`/realized?year=${year}`).then(r => r.data),
    staleTime: 60_000,
  });
}

export function useRealizedYears() {
  return useQuery<RealizedYear[]>({
    queryKey: ["realized", "years"],
    queryFn: () =>
      api.get<ApiOk<{ years: RealizedYear[] }>>("/realized/years")
        .then(r => r.data.years),
    staleTime: 60_000,
  });
}
