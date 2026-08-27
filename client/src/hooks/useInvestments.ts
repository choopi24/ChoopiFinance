import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ApiOk } from "../lib/api";
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
  // Future-value projection inputs
  expected_annual_return: number | null;
  monthly_contribution: number | null;
  // Israeli fund linkage + fees
  fund_id: number | null;
  fund_track: string | null;
  fee_deposit_pct: number | null;
  fee_balance_pct: number | null;
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
  // Israeli fund estimate (regulator-published yields)
  value_estimated: boolean;
  last_reported_balance_nis: number | null;
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

/**
 * Symbol / fund typeahead was removed with the price + fund providers — there is
 * no source to search. Symbols are typed in by hand.
 */

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

export interface InvestmentHistoryPoint {
  t: string;          // ISO timestamp of the reading
  value_nis: number;  // value at that point, NIS-denominated
}

export interface InvestmentHistory {
  id: number;
  type: AssetType;
  points: InvestmentHistoryPoint[];
}

/** Value-over-time series for a single investment (lazy — only fetches when enabled). */
export function useInvestmentHistory(investmentId: number | null, enabled: boolean) {
  return useQuery<InvestmentHistory>({
    queryKey: ["investments", investmentId, "history"],
    queryFn: () =>
      api.get<ApiOk<InvestmentHistory>>(
        `/investments/${investmentId}/history`
      ).then(r => r.data),
    enabled: enabled && investmentId !== null,
    staleTime: 60_000,
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
  monthly_deposit?: number;
  deposit_currency?: string;
  expected_annual_return?: number | null;
  monthly_contribution?: number | null;
  fund_id?: number | null;
  fund_track?: string | null;
  fee_deposit_pct?: number | null;
  fee_balance_pct?: number | null;
  /** When present for market types, creates a synthetic BUY in the same server request. */
  holding?: {
    units: number;
    avg_price: number;
    currency: string;
    as_of: string;
  };
}

export interface AddTransactionBody {
  investment_id: number;
  kind: "BUY" | "SELL" | "DIV" | "UPDATE" | "DEPOSIT";
  units?: number;
  price_per_unit?: number;
  total_amount?: number;
  currency: string;
  occurred_at: string;
  notes?: string;
  fx_rate_at_buy?: number;
}

export interface BulkTransactionRow {
  kind: "BUY" | "SELL" | "DIV" | "UPDATE" | "DEPOSIT";
  units?: number;
  price_per_unit?: number;
  total_amount?: number;
  currency?: string;
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
      qc.invalidateQueries({ queryKey: ["realized"] });
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
      qc.invalidateQueries({ queryKey: ["realized"] });
    },
  });
}

/**
 * Body for PATCH /investments/:id. Distinct from CreateInvestmentBody because
 * partial edits must be able to CLEAR a field: explicit null clears it, while
 * an absent key leaves it untouched (undefined is dropped by JSON.stringify).
 */
export interface EditInvestmentBody {
  name?: string;
  ticker?: string | null;
  isin?: string | null;
  broker?: string | null;
  etf_kind?: "accumulating" | "distributing" | null;
  liquid_date?: string | null;
  monthly_deposit?: number | null;
  deposit_currency?: string;
  expected_annual_return?: number | null;
  monthly_contribution?: number | null;
  fund_id?: number | null;
  fund_track?: string | null;
  fee_deposit_pct?: number | null;
  fee_balance_pct?: number | null;
}

export function useEditInvestment() {
  const qc = useQueryClient();
  return useMutation<Investment, Error, { id: number; body: EditInvestmentBody }>({
    mutationFn: ({ id, body }) =>
      api.patch<ApiOk<Investment>>(`/investments/${id}`, body).then(r => r.data),
    onSuccess: updated => {
      // Write the server's enriched row straight into every cached list —
      // synchronously — so re-opening the edit form right away seeds from
      // post-edit values instead of the pre-refetch cache.
      qc.setQueriesData<Investment[]>({ queryKey: ["investments"] }, old =>
        Array.isArray(old) ? old.map(i => (i.id === updated.id ? updated : i)) : old
      );
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["realized"] });
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
      qc.invalidateQueries({ queryKey: ["realized"] });
    },
  });
}

export function useBulkTransactions() {
  const qc = useQueryClient();
  return useMutation<
    { inserted: number },
    Error,
    { investment_id: number; transactions: BulkTransactionRow[] }
  >({
    mutationFn: body =>
      api.post<ApiOk<{ inserted: number }>>("/transactions/bulk", body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["realized"] });
    },
  });
}

/**
 * Add a cash contribution to an education/other fund. Atomically raises both the
 * recorded balance and net-deposited by `amount`, so the contribution never shows
 * up as profit (P/L = value − deposited stays unchanged).
 */
export function useContribute() {
  const qc = useQueryClient();
  return useMutation<
    { id: number; amount: number; currency: string; new_balance: number },
    Error,
    { id: number; amount: number; currency: string; occurred_at: string; notes?: string }
  >({
    mutationFn: ({ id, ...body }) =>
      api.post<ApiOk<{ id: number; amount: number; currency: string; new_balance: number }>>(
        `/investments/${id}/contribute`, body
      ).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["realized"] });
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
      qc.invalidateQueries({ queryKey: ["realized"] });
    },
  });
}
