import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

interface RefreshResult {
  last_sync: string;
  count: number;
}

interface ApiOk<T> { success: true; data: T }

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
