const BASE = "/api";

/** Standard success envelope returned by the API (respond.ts `ok`). */
export interface ApiOk<T> { success: true; data: T }

// ── Connection status pub/sub ───────────────────────────────────────────────
// Lets a global banner react when the API becomes unreachable (server down, or
// the dev proxy returning a non-JSON error page) instead of surfacing a cryptic
// "Unexpected token < … not valid JSON" on every button.
type ConnListener = (online: boolean) => void;
const connListeners = new Set<ConnListener>();
export function onConnectionChange(l: ConnListener): () => void {
  connListeners.add(l);
  return () => connListeners.delete(l);
}
function emitConnection(online: boolean) {
  for (const l of connListeners) l(online);
}

const UNREACHABLE = "Can't reach the server. Is it running?";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers },
      ...init,
    });
  } catch {
    // Network-level failure (server down, DNS, CORS) — fetch rejects.
    emitConnection(false);
    throw Object.assign(new Error(UNREACHABLE), { isConnectionError: true });
  }

  if (!res.ok) {
    // A real API error responds with JSON; a dead proxy responds with HTML.
    const body = await res.json().catch(() => null);
    if (body == null) {
      emitConnection(false);
      throw Object.assign(new Error(UNREACHABLE), { isConnectionError: true, status: res.status });
    }
    emitConnection(true);
    throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status });
  }

  try {
    const data = (await res.json()) as T;
    emitConnection(true);
    return data;
  } catch {
    // 2xx but unparseable (e.g. SPA fallback HTML from a dead proxy).
    emitConnection(false);
    throw Object.assign(new Error(UNREACHABLE), { isConnectionError: true });
  }
}

export const api = {
  get:    <T>(path: string)               => request<T>(path),
  post:   <T>(path: string, body: unknown) => request<T>(path, { method: "POST",   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH",  body: JSON.stringify(body) }),
  delete: <T>(path: string)               => request<T>(path, { method: "DELETE" }),
};
