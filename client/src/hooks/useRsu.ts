import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiOk } from "../lib/api";
import type { Investment } from "./useInvestments";

// ── Types (mirror server grantPayload) ────────────────────────────────────────

export interface RsuEvent {
  id: number;
  grant_id: number;
  vest_date: string;
  units: number;
  fmv_at_vest: number | null;
  status: "scheduled" | "vested";
  transaction_id: number | null;
  created_at: string;
}

export interface RsuGrant {
  id: number;
  investment_id: number;
  user_id: number;
  symbol: string;
  company_name: string | null;
  grant_date: string;
  total_units: number;
  grant_price: number | null;
  currency: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  events: RsuEvent[];
  vested_units: number;
  unvested_units: number;
  /** Past-dated events not yet materialized (waiting on FMV / a refresh). */
  due_units: number;
  next_vest_event: { vest_date: string; units: number } | null;
  /** Enriched valuation of the linked investment (value, cost basis, P/L in NIS). */
  investment: Investment | null;
}

export interface VestingRuleInput {
  cliff_months: number;
  total_months: number;
  frequency: "monthly" | "quarterly" | "annual";
}

export interface ManualEventInput {
  vest_date: string;
  units: number;
  fmv_at_vest?: number | null;
}

export interface CreateRsuGrantBody {
  symbol: string;
  company_name?: string;
  grant_date: string;
  total_units: number;
  grant_price?: number;
  currency?: string;
  broker?: string;
  notes?: string;
  rule?: VestingRuleInput;
  events?: ManualEventInput[];
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function useRsuGrants() {
  return useQuery<RsuGrant[]>({
    queryKey: ["rsu"],
    queryFn: () => api.get<ApiOk<RsuGrant[]>>("/rsu").then(r => r.data),
    staleTime: 60_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────
// Any RSU change can move vested lots, so valuation-adjacent queries invalidate too.

function useInvalidateRsu() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["rsu"] });
    qc.invalidateQueries({ queryKey: ["investments"] });
    qc.invalidateQueries({ queryKey: ["portfolio"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["realized"] });
  };
}

export function useCreateRsuGrant() {
  const invalidate = useInvalidateRsu();
  return useMutation<RsuGrant, Error, CreateRsuGrantBody>({
    mutationFn: body => api.post<ApiOk<RsuGrant>>("/rsu", body).then(r => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdateRsuGrant() {
  const invalidate = useInvalidateRsu();
  return useMutation<RsuGrant, Error, { id: number; body: Partial<Pick<CreateRsuGrantBody, "company_name" | "notes" | "grant_price">> }>({
    mutationFn: ({ id, body }) => api.patch<ApiOk<RsuGrant>>(`/rsu/${id}`, body).then(r => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteRsuGrant() {
  const invalidate = useInvalidateRsu();
  return useMutation<unknown, Error, number>({
    mutationFn: id => api.delete<ApiOk<unknown>>(`/rsu/${id}`).then(r => r.data),
    onSuccess: invalidate,
  });
}

/** Recompute vesting: materialize due events into FIFO lots (fetches missing FMVs). */
export function useRefreshRsuGrant() {
  const invalidate = useInvalidateRsu();
  return useMutation<RsuGrant & { vested: number; needs_fmv: number }, Error, number>({
    mutationFn: id =>
      api.post<ApiOk<RsuGrant & { vested: number; needs_fmv: number }>>(`/rsu/${id}/refresh`, {}).then(r => r.data),
    onSuccess: invalidate,
  });
}

export function useAddRsuEvent() {
  const invalidate = useInvalidateRsu();
  return useMutation<RsuGrant, Error, { grantId: number; body: ManualEventInput }>({
    mutationFn: ({ grantId, body }) =>
      api.post<ApiOk<RsuGrant>>(`/rsu/${grantId}/events`, body).then(r => r.data),
    onSuccess: invalidate,
  });
}

export function useUpdateRsuEvent() {
  const invalidate = useInvalidateRsu();
  return useMutation<RsuGrant, Error, { eventId: number; body: Partial<ManualEventInput> }>({
    mutationFn: ({ eventId, body }) =>
      api.patch<ApiOk<RsuGrant>>(`/rsu/events/${eventId}`, body).then(r => r.data),
    onSuccess: invalidate,
  });
}

export function useDeleteRsuEvent() {
  const invalidate = useInvalidateRsu();
  return useMutation<RsuGrant, Error, number>({
    mutationFn: eventId => api.delete<ApiOk<RsuGrant>>(`/rsu/events/${eventId}`).then(r => r.data),
    onSuccess: invalidate,
  });
}
