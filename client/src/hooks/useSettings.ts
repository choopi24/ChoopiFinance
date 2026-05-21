import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface UserSettings {
  display_currency: string;
  fx_override: number | null;
  theme: string;
  display_name: string | null;
  stay_signed_in: number;
  show_on_lock_screen: number;
}

interface ApiOk<T> { success: true; data: T }

export function useUserSettings() {
  return useQuery<UserSettings>({
    queryKey: ["user-settings"],
    queryFn: () => api.get<ApiOk<UserSettings>>("/settings").then(r => r.data),
    staleTime: Infinity,
  });
}

export function useUpdateDisplayName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (display_name: string | null) =>
      api.patch<ApiOk<{ display_name: string | null }>>("/settings/display-name", { display_name })
        .then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-settings"] }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: ({ current_password, new_password }: { current_password: string; new_password: string }) =>
      api.patch<ApiOk<{ ok: boolean }>>("/settings/password", { current_password, new_password })
        .then(r => r.data),
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: { stay_signed_in?: boolean; show_on_lock_screen?: boolean }) =>
      api.patch<ApiOk<{ ok: boolean }>>("/settings/preferences", prefs).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-settings"] }),
  });
}

export function useTriggerSnapshot() {
  return useMutation({
    mutationFn: () =>
      api.post<ApiOk<{ ok: boolean; snapshot_at: string }>>("/settings/snapshot", {})
        .then(r => r.data),
  });
}

export function useResetData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      // DELETE with body isn't supported by our api helper, use post workaround via fetch
      fetch("/api/settings/data", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "RESET" }),
      }).then(r => r.json()).then((r: ApiOk<{ ok: boolean }>) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      qc.invalidateQueries({ queryKey: ["realized"] });
    },
  });
}

export function useCsvPreview() {
  return useMutation({
    mutationFn: ({ type, content }: { type: string; content: string }) =>
      api.post<ApiOk<{
        rows_total: number;
        rows_valid: number;
        rows_invalid: number;
        errors: { row: number; field: string; message: string }[];
        preview_rows: Record<string, string>[];
      }>>(`/csv/preview/${type}`, { content }).then(r => r.data),
  });
}

export function useCsvImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, content }: { type: string; content: string }) =>
      api.post<ApiOk<{ investments_created: number; transactions_created: number }>>(
        `/csv/import/${type}`, { content }
      ).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

// ── Wide-matrix import (pension / education / other) ──────────────────────────

export interface FundPreview {
  originalName: string;
  suggestedName: string;
  detectedType: "pension" | "education" | "other";
  snapshotCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  earliestValue: number;
  latestValue: number;
  gain: number;
  gainPct: number;
}

export interface MatrixPreviewData {
  funds: FundPreview[];
  errors: { row: number; field: string; message: string }[];
  skipped_cells: number;
}

export function useCsvMatrixPreview() {
  return useMutation({
    mutationFn: ({ content }: { content: string }) =>
      api.post<ApiOk<MatrixPreviewData>>("/csv/preview-matrix", { content }).then(r => r.data),
  });
}

export function useCsvMatrixImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ content, funds }: {
      content: string;
      funds: Array<{ originalName: string; name: string; type: string }>;
    }) =>
      api.post<ApiOk<{ investments_created: number; transactions_created: number }>>(
        "/csv/import-matrix", { content, funds }
      ).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investments"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}
