import { useState, useEffect, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

interface RefreshResult {
  last_sync: string;
  count: number;
}

interface ApiOk<T> { success: true; data: T }

export interface Quote {
  symbol: string;
  price: number;
  currency: string;
  name: string;
  as_of: string;
}

/**
 * On-demand single quote for value-based entry (derive units from a price).
 * Debounced so typing a ticker doesn't fire a request per keystroke.
 * A 404 (unpriceable ticker) surfaces as the query error — no retry.
 */
export function useQuote(ticker: string, type: string, date: string | undefined, enabled: boolean) {
  const [debounced, setDebounced] = useState(ticker);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(ticker), 300);
    return () => clearTimeout(t);
  }, [ticker]);

  return useQuery<Quote>({
    queryKey: ["lookup", "quote", type, debounced, date ?? "today"],
    queryFn: () => {
      const params = new URLSearchParams({ ticker: debounced, type });
      if (date) params.set("date", date);
      return api.get<ApiOk<Quote>>(`/lookup/quote?${params.toString()}`).then(r => r.data);
    },
    enabled: enabled && debounced.trim().length >= 1,
    staleTime: 30_000,
    retry: false,
  });
}

export function usePrices() {
  const queryClient = useQueryClient();
  const [lastSync, setLastSync] = useState<string | null>(null);

  const mutation = useMutation<RefreshResult, Error>({
    mutationFn: () =>
      api.post<ApiOk<RefreshResult>>("/prices/refresh", {}).then(r => r.data),
    onSuccess: (data) => {
      setLastSync(data.last_sync);
      // Invalidate portfolio so the updated prices are reflected immediately
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });

  const refresh = useCallback(() => {
    mutation.mutate();
  }, [mutation]);

  return {
    refresh,
    isRefreshing: mutation.isPending,
    lastSync,
  };
}
