import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RotateCw } from "lucide-react";
import { api, onConnectionChange } from "../lib/api";

/**
 * Global banner shown when the API becomes unreachable. Replaces the cryptic
 * JSON-parse errors users hit when the server is down. Auto-hides once any
 * request succeeds again; "Retry" refetches all active queries.
 */
export function ConnectionBanner() {
  const [offline, setOffline] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const qc = useQueryClient();

  useEffect(() => onConnectionChange(online => setOffline(!online)), []);

  if (!offline) return null;

  async function retry() {
    setRetrying(true);
    try {
      // Ping health first — flips the connection state on success even when there
      // are no active queries (e.g. on the login page). Then refresh app data.
      await api.get("/health");
      await qc.refetchQueries();
    } catch {
      /* still down — banner stays */
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="cf-conn-banner" role="alert" aria-live="assertive">
      <AlertTriangle size={15} strokeWidth={1.8} />
      <span className="cf-conn-banner-text">
        Can't reach the server. It may be offline — start it and try again.
      </span>
      <button className="cf-conn-banner-btn" onClick={retry} disabled={retrying}>
        <RotateCw size={13} strokeWidth={1.8} style={{ animation: retrying ? "spin 1s linear infinite" : "none" }} />
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
