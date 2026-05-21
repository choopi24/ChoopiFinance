import { X, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

interface InvRow {
  id: number;
  name: string;
  type: string;
  stale_level: "stale-30" | "stale-60" | null;
  stale_days: number | null;
  last_update_at: string | null;
}

interface ApiOk<T> { success: true; data: T }

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
