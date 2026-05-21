import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface FxRateData {
  from: string;
  to: string;
  rate: number;
  source: "cached" | "fallback" | "override";
  fetched_at: string | null;
  override: number | null;
}

interface ApiOk<T> { success: true; data: T }
interface SettingsData { display_currency: string; fx_override: number | null }

export function useFxRate() {
  return useQuery<FxRateData>({
    queryKey: ["fx", "USD", "NIS"],
    queryFn: () =>
      api.get<ApiOk<FxRateData>>("/fx/rate?from=USD&to=NIS").then(r => r.data),
    staleTime: 15 * 60 * 1_000,
    refetchInterval: 15 * 60 * 1_000,
  });
}

export function useSettings() {
  return useQuery<SettingsData>({
    queryKey: ["settings"],
    queryFn: () =>
      api.get<ApiOk<SettingsData>>("/settings").then(r => r.data),
    staleTime: Infinity,
  });
}

export function useFxOverride() {
  const queryClient = useQueryClient();

  return useMutation<SettingsData, Error, number | null>({
    mutationFn: (rate) =>
      api.patch<ApiOk<SettingsData>>("/settings/fx-override", { rate }).then(r => r.data),
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      // Refresh FX + portfolio with new override
      queryClient.invalidateQueries({ queryKey: ["fx"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}
