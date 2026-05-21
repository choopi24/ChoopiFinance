import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { AssetType } from "@choopi/shared";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Investment {
  id: number;
  user_id: number;
  type: AssetType;
  name: string;
  ticker: string | null;
  isin: string | null;
  broker: string | null;
  etf_kind: "accumulating" | "distributing" | null;
  liquid_date: string | null;
  closed_at: string | null;
  created_at: string;
  // Pension deposit model
  monthly_deposit: number | null;
  deposit_currency: string;
  // Position (from enrichment)
  remaining_units: number;
  cost_basis_nis: number;
  /** Actual cash deposited, NIS-denominated (mirrors cost_basis_nis for non-market types). */
  net_deposited_nis: number;
  current_value_nis: number;
  current_price: number | null;
  current_price_currency: string | null;
  price_cached_at: string | null;
  unrealized_pl_nis: number;
  unrealized_pct: number | null;
  realized_pl_nis: number;
  currency: string;
  // Stale (manual types)
  last_update_at: string | null;
  stale_days: number | null;
  stale_level: "stale-30" | "stale-60" | null;
  update_count: number;
  fx_rate_used: number;
  fx_source: string;
}

export interface ExistingCheck {
  id: number;
  name: string;
  ticker: string;
  type: string;
  broker: string | null;
  remaining_units: number;
  current_value_nis: number;
  unrealized_pl_nis: number;
}

interface ApiOk<T> { success: true; data: T }

// ── Queries ───────────────────────────────────────────────────────────────────

export function useInvestments(includeClosed = false) {
  return useQuery<Investment[]>({
    queryKey: ["investments", { includeClosed }],
    queryFn: () =>
      api.get<ApiOk<Investment[]>>(
        `/investments?include_closed=${includeClosed}`
      ).then(r => r.data),
    staleTime: 60_000,
  });
}

export function useCheckExisting(ticker: string, type: string, enabled: boolean) {
  return useQuery<ExistingCheck | null>({
    queryKey: ["investments", "check-existing", ticker, type],
    queryFn: () =>
      api.get<ApiOk<ExistingCheck | null>>(
        `/investments/check-existing?ticker=${encodeURIComponent(ticker)}&type=${type}`
      ).then(r => r.data),
    enabled: enabled && ticker.length >= 1,
    staleTime: 30_000,
  });
}

export function useTxCount(investmentId: number | null) {
  return useQuery<{ id: number; name: string; tx_count: number; realized_count: number }>({
    queryKey: ["investments", investmentId, "tx-count"],
    queryFn: () =>
      api.get<ApiOk<{ id: number; name: string; tx_count: number; realized_count: number }>>(
        `/investments/${investmentId}/tx-count`
      ).then(r => r.data),
    enabled: investmentId !== null,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export interface CreateInvestmentBody {
  type: string;
  name: string;
  ticker?: string;
  isin?: string;
  broker?: string;
  etf_kind?: string;
  liquid_date?: string;
  initial_balance?: number;
  currency?: string;
  occurred_at?: string;
}

export interface AddTransactionBody {
  investment_id: number;
  kind: "BUY" | "SELL" | "DIV" | "UPDATE";
  units?: number;
  price_per_unit?: number;
  total_amount?: number;
  currency: string;
  wallet_id?: number | null;
  occurred_at: string;
  notes?: string;
  fx_rate_at_buy?: number;
}

export function useCreateInvestment() {
  const qc = useQueryClient();
  return useMutation<Investment, Error, CreateInvestmentBody>({
    mutationFn: body =>
      api.post<ApiOk<Investment>>("/investments", body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useAddTransaction() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, AddTransactionBody>({
    mutationFn: body =>
      api.post<ApiOk<unknown>>("/transactions", body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}

export function useEditInvestment() {
  const qc = useQueryClient();
  return useMutation<Investment, Error, { id: number; body: Partial<CreateInvestmentBody> }>({
    mutationFn: ({ id, body }) =>
      api.patch<ApiOk<Investment>>(`/investments/${id}`, body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useDeleteInvestment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, number>({
    mutationFn: id => api.delete<ApiOk<unknown>>(`/investments/${id}`).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useUpdateBalance() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    { id: number; balance: number; currency: string; occurred_at: string; notes?: string }
  >({
    mutationFn: ({ id, ...body }) =>
      api.post<ApiOk<unknown>>(`/investments/${id}/update-balance`, body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}
