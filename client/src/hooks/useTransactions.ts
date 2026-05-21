import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { TransactionKind } from "@choopi/shared";

export interface Transaction {
  id: number;
  investment_id: number;
  investment_name: string;
  investment_type: string;
  ticker: string | null;
  kind: TransactionKind;
  units: number | null;
  price_per_unit: number | null;
  total_amount: number;
  currency: "NIS" | "USD";
  occurred_at: string;
  notes: string | null;
  realized_pl: number | null;
}

interface ApiOk<T> { success: true; data: T }
interface PagedResult<T> { data: T[]; total: number; page: number; per_page: number }

export interface TransactionFilters {
  investment_id?: number;
  kinds?: TransactionKind[];
  from?: string;
  to?: string;
  page?: number;
  per_page?: number;
}

export function useRecentTransactions(limit = 5) {
  return useQuery<Transaction[]>({
    queryKey: ["transactions", "recent", limit],
    queryFn: () =>
      api.get<ApiOk<PagedResult<Transaction>>>(`/transactions?per_page=${limit}`)
        .then(r => r.data.data),
    staleTime: 60 * 1_000,
  });
}

export function useTransactions(filters: TransactionFilters = {}) {
  const { investment_id, kinds, from, to, page = 1, per_page = 50 } = filters;
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("per_page", String(per_page));
  if (investment_id) params.set("investment_id", String(investment_id));
  if (kinds?.length === 1) params.set("kind", kinds[0]);
  if (from) params.set("from", from);
  if (to)   params.set("to", to);

  return useQuery<PagedResult<Transaction>>({
    queryKey: ["transactions", "paged", filters],
    queryFn: () =>
      api.get<ApiOk<PagedResult<Transaction>>>(`/transactions?${params}`)
        .then(r => r.data),
    staleTime: 30_000,
  });
}

export function useFifoAffected(txId: number | null) {
  return useQuery<{ id: number; affected_sells: number }>({
    queryKey: ["transactions", "fifo-affected", txId],
    queryFn: () =>
      api.get<ApiOk<{ id: number; affected_sells: number }>>(`/transactions/${txId}/fifo-affected`)
        .then(r => r.data),
    enabled: txId != null,
    staleTime: 10_000,
  });
}

export function useEditTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<Transaction> & { id: number }) =>
      api.patch<ApiOk<Transaction>>(`/transactions/${id}`, body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["realized"] });
      qc.invalidateQueries({ queryKey: ["investments"] });
    },
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      api.delete<ApiOk<{ id: number }>>(`/transactions/${id}`).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["realized"] });
      qc.invalidateQueries({ queryKey: ["investments"] });
    },
  });
}
