/**
 * Session state: display currency, theme, settings, and the few preferences
 * that make the quick-add sheet feel like it remembers you.
 *
 * localStorage is wrapped because it throws outright in some private-browsing
 * modes — a tracker that white-screens because it couldn't cache a preference
 * would be a poor trade.
 */

const KEY = "choopi.";

function readLocal(key, fallback = null) {
  try { return localStorage.getItem(KEY + key) ?? fallback; } catch { return fallback; }
}
function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(KEY + key);
    else localStorage.setItem(KEY + key, String(value));
  } catch { /* preference simply won't persist */ }
}

const listeners = new Set();

export const state = {
  currency: "ILS",
  theme: readLocal("theme", "system"),
  settings: {},
  /** Quick-add remembers the last account you filed something under. */
  lastAccountId: Number(readLocal("lastAccount")) || null,
  /** Last range used on the dashboard chart, so it survives navigation. */
  range: readLocal("range", "1Y"),
  allocationBy: readLocal("allocationBy", "category"),
};

export function setCurrency(currency) {
  state.currency = currency;
  writeLocal("currency", currency);
  notify();
}

export function setRange(range) {
  state.range = range;
  writeLocal("range", range);
}

export function setAllocationBy(by) {
  state.allocationBy = by;
  writeLocal("allocationBy", by);
}

export function rememberAccount(id) {
  state.lastAccountId = id ?? null;
  writeLocal("lastAccount", id ?? null);
}

export function applySettings(settings) {
  state.settings = settings || {};
  // The server's stored currency is the source of truth; the local copy only
  // avoids a flash of the wrong symbol before the first response lands.
  state.currency = settings?.display_currency === "USD" ? "USD" : "ILS";
  writeLocal("currency", state.currency);
  if (settings?.theme) setTheme(settings.theme, { persistRemote: false });
}

/** Resolve "system" against the OS setting and stamp it on <html>. */
export function setTheme(theme, { persistRemote = true } = {}) {
  state.theme = theme;
  writeLocal("theme", theme);
  const dark = theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  notify({ theme: true });
  return persistRemote;
}

/** Hydrate the pre-paint guess from localStorage before the server answers. */
export function bootLocal() {
  const c = readLocal("currency");
  if (c === "ILS" || c === "USD") state.currency = c;
  setTheme(state.theme, { persistRemote: false });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(detail = {}) {
  for (const fn of listeners) fn(detail);
}

// A phone that switches to dark at sunset should follow along while open.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.theme === "system") setTheme("system", { persistRemote: false });
});
