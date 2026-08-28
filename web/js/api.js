/**
 * The one place that talks to the server.
 *
 * Every endpoint answers `{ success, data }` or `{ success, error }`, so this
 * unwraps the envelope and throws a plain Error carrying the server's message —
 * which is always written to be shown to a human as-is.
 */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    // No network at all: the server is off, or the phone wandered off the Wi-Fi.
    throw new ApiError("Can't reach the server — is it still running on your Mac?", 0);
  }

  if (res.status === 401) {
    throw new ApiError("Not signed in", 401);
  }

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok || payload?.success === false) {
    throw new ApiError(payload?.error || `Request failed (${res.status})`, res.status);
  }
  return payload?.data ?? payload;
}

/** Build "?a=1&b=2", dropping empty values so defaults stay server-side. */
function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

export const api = {
  ApiError,

  auth: {
    status: () => request("GET", "/auth/status"),
    setup: (pin) => request("POST", "/auth/setup", { pin }),
    unlock: (pin) => request("POST", "/auth/unlock", { pin }),
    change: (current_pin, new_pin) => request("POST", "/auth/change", { current_pin, new_pin }),
    lock: () => request("POST", "/auth/lock"),
  },

  portfolio: {
    summary: (p) => request("GET", `/portfolio/summary${qs(p)}`),
    series: (p) => request("GET", `/portfolio/series${qs(p)}`),
    allocation: (p) => request("GET", `/portfolio/allocation${qs(p)}`),
    feesMonthly: (p) => request("GET", `/portfolio/fees-monthly${qs(p)}`),
    attention: (p) => request("GET", `/portfolio/attention${qs(p)}`),
  },

  accounts: {
    list: (p) => request("GET", `/accounts${qs(p)}`),
    get: (id, p) => request("GET", `/accounts/${id}${qs(p)}`),
    series: (id, p) => request("GET", `/accounts/${id}/series${qs(p)}`),
    projection: (id, p) => request("GET", `/accounts/${id}/projection${qs(p)}`),
    create: (body) => request("POST", "/accounts", body),
    update: (id, body) => request("PATCH", `/accounts/${id}`, body),
    remove: (id) => request("DELETE", `/accounts/${id}`),
    addHolding: (id, body) => request("POST", `/accounts/${id}/holdings`, body),
  },

  holdings: {
    list: (p) => request("GET", `/holdings${qs(p)}`),
    update: (id, body) => request("PATCH", `/holdings/${id}`, body),
    remove: (id) => request("DELETE", `/holdings/${id}`),
  },

  transactions: {
    list: (p) => request("GET", `/transactions${qs(p)}`),
    create: (body) => request("POST", "/transactions", body),
    update: (id, body) => request("PATCH", `/transactions/${id}`, body),
    remove: (id) => request("DELETE", `/transactions/${id}`),
    restore: (row) => request("POST", "/transactions/restore", row),
  },

  prices: {
    list: (p) => request("GET", `/prices${qs(p)}`),
    create: (body) => request("POST", "/prices", body),
    update: (id, body) => request("PATCH", `/prices/${id}`, body),
    remove: (id) => request("DELETE", `/prices/${id}`),
  },

  valuations: {
    list: (p) => request("GET", `/valuations${qs(p)}`),
    create: (body) => request("POST", "/valuations", body),
    update: (id, body) => request("PATCH", `/valuations/${id}`, body),
    remove: (id) => request("DELETE", `/valuations/${id}`),
  },

  fx: {
    list: (p) => request("GET", `/fx${qs(p)}`),
    resolve: (p) => request("GET", `/fx/resolve${qs(p)}`),
    create: (body) => request("POST", "/fx", body),
    update: (id, body) => request("PATCH", `/fx/${id}`, body),
    remove: (id) => request("DELETE", `/fx/${id}`),
  },

  recurring: {
    list: (p) => request("GET", `/recurring${qs(p)}`),
    upcoming: (p) => request("GET", `/recurring/upcoming${qs(p)}`),
    generate: () => request("POST", "/recurring/generate"),
    create: (body) => request("POST", "/recurring", body),
    update: (id, body) => request("PATCH", `/recurring/${id}`, body),
    remove: (id) => request("DELETE", `/recurring/${id}`),
  },

  rsu: {
    overview: (p) => request("GET", `/rsu${qs(p)}`),
    createGrant: (body) => request("POST", "/rsu/grants", body),
    updateGrant: (id, body) => request("PATCH", `/rsu/grants/${id}`, body),
    removeGrant: (id) => request("DELETE", `/rsu/grants/${id}`),
    updateVest: (id, body) => request("PATCH", `/rsu/vests/${id}`, body),
    removeVest: (id) => request("DELETE", `/rsu/vests/${id}`),
  },

  settings: {
    get: () => request("GET", "/settings"),
    update: (body) => request("PATCH", "/settings", body),
    importLedger: (body) => request("POST", "/settings/import", body),
    importCsv: (table, csv) => request("POST", `/csv/${table}`, { csv }),
  },

  backups: {
    list: () => request("GET", "/settings/backups"),
    run: () => request("POST", "/settings/backup"),
    fingerprint: () => request("GET", "/settings/fingerprint"),
    /** A plain link, so the browser saves the file itself with the cookie attached. */
    downloadUrl: (file) => `/api/settings/backups/${encodeURIComponent(file)}`,
  },
};
