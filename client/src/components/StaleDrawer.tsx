import { useState } from "react";
import { X, RefreshCw, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiOk } from "../lib/api";
import { Button } from "./Button";

interface InvRow {
  id: number;
  name: string;
  type: string;
  stale_level: "stale-30" | "stale-60" | null;
  stale_days: number | null;
  last_update_at: string | null;
}

function useStaleInvestments() {
  return useQuery<InvRow[]>({
    queryKey: ["investments", "stale"],
    queryFn: () =>
      api.get<ApiOk<InvRow[]>>("/investments").then(r =>
        (r.data as InvRow[]).filter(i => i.stale_level !== null)
      ),
    staleTime: 5 * 60 * 1_000,
  });
}

interface StaleDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function StaleDrawer({ open, onClose }: StaleDrawerProps) {
  const { data: stale = [] } = useStaleInvestments();

  if (!open) return null;

  return (
    <div className="cf-drawer-overlay" onClick={onClose}>
      <div className="cf-drawer" onClick={e => e.stopPropagation()}>
        <div className="cf-drawer-head">
          <span className="cf-drawer-title">Stale Positions</span>
          <button className="cf-icon-btn" onClick={onClose} title="Close">
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>

        {stale.length === 0 ? (
          <div className="cf-drawer-empty">
            <RefreshCw size={22} strokeWidth={1.4} style={{ color: "var(--text-faint)" }} />
            <div>All positions are up to date</div>
          </div>
        ) : (
          <ul className="cf-drawer-list">
            {stale.map(inv => (
              <li key={inv.id} className="cf-drawer-item">
                <div>
                  <div className="cf-drawer-item-name">{inv.name}</div>
                  <div className="cf-drawer-item-sub">
                    {inv.stale_days != null ? `${inv.stale_days}d since last update` : "Never updated"}
                    {" · "}
                    <span style={{ color: inv.stale_level === "stale-60" ? "var(--rose)" : "var(--c-pension)" }}>
                      {inv.stale_level === "stale-60" ? "Very stale" : "Stale"}
                    </span>
                  </div>
                </div>
                <button
                  className="cf-link"
                  onClick={() => { window.location.href = `/investments/${inv.id}`; onClose(); }}
                >
                  Update
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Dismissible amber top banner — replaces the alarming slide-in drawer (Sec. 5). */
export function StaleBanner({ onReview }: { onReview: () => void }) {
  const { data: stale = [] } = useStaleInvestments();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || stale.length === 0) return null;

  const names = stale.slice(0, 2).map(s => s.name).join(" & ");
  const extra = stale.length > 2 ? ` +${stale.length - 2} more` : "";
  const plural = stale.length > 1;

  return (
    <div className="cf-stale-banner">
      <span className="ico"><AlertTriangle size={16} strokeWidth={1.8} /></span>
      <div className="msg">
        <b>{stale.length} holding{plural ? "s" : ""} need{plural ? "" : "s"} a refresh.</b>{" "}
        {names}{extra} haven't been updated in 30+ days.
      </div>
      <Button variant="ghost" size="sm" onClick={onReview}>Review</Button>
      <button className="x" onClick={() => setDismissed(true)} aria-label="Dismiss">
        <X size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}

export function useStaleCount() {
  const { data } = useQuery<InvRow[]>({
    queryKey: ["investments", "stale"],
    queryFn: () =>
      api.get<ApiOk<InvRow[]>>("/investments").then(r =>
        (r.data as InvRow[]).filter(i => i.stale_level !== null)
      ),
    staleTime: 5 * 60 * 1_000,
  });
  return data?.length ?? 0;
}
