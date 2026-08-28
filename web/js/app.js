/**
 * Bootstrap, shell and router.
 *
 * A hash router, because the app is served as static files from Express with a
 * catch-all — hash routes need no server cooperation at all and survive a
 * refresh on a phone that has been in a pocket for two days.
 */

import { api } from "./api.js";
import { state, bootLocal, subscribe, applySettings } from "./state.js";
import { h, render, frag, iconEl, errorToast, toast } from "./ui.js";
import { icon } from "./icons.js";
import { destroyAll, retheme } from "./charts.js";
import { openQuickAdd } from "./quickadd.js";
import { registerServiceWorker } from "./pwa.js";
import { loginScreen } from "./screens/login.js";
import { dashboardScreen } from "./screens/dashboard.js";
import { accountsScreen } from "./screens/accounts.js";
import { accountScreen } from "./screens/account.js";
import { rsuScreen } from "./screens/rsu.js";
import { settingsScreen } from "./screens/settings.js";

const root = document.getElementById("app");

/**
 * The passcode screen binds a document-level keydown listener. Without this,
 * every failed unlock would leave another one attached and digits would start
 * arriving twice.
 */
let activeCleanup = null;
function showScreen(node) {
  activeCleanup?.();
  activeCleanup = node?.cleanup ?? null;
  render(root, node);
}

const TABS = [
  { href: "#/",         icon: "home",     label: "Dashboard" },
  { href: "#/accounts", icon: "wallet",   label: "Accounts" },
  { href: "#/rsu",      icon: "grant",    label: "RSUs" },
  { href: "#/settings", icon: "settings", label: "Settings" },
];

const ROUTES = [
  [/^\/?$/,                  dashboardScreen],
  [/^\/accounts\/(\d+)$/,    accountScreen],
  [/^\/accounts\/?$/,        accountsScreen],
  [/^\/rsu\/?$/,             rsuScreen],
  [/^\/settings\/?$/,        settingsScreen],
];

/**
 * The path half of the hash, without its query string.
 *
 * Screens keep their view state in the hash query — "#/accounts?sort=value",
 * "#/accounts/3?tab=prices" — so a filtered or tabbed view survives a reload
 * and can be pinned to the phone's home screen. The router must match on the
 * path alone, or every one of those URLs falls through to the dashboard.
 */
function currentPath() {
  const raw = location.hash.replace(/^#/, "").split("?")[0];
  return decodeURIComponent(raw) || "/";
}

function matchRoute(path) {
  for (const [pattern, screen] of ROUTES) {
    const m = pattern.exec(path);
    if (m) return { screen, params: m.slice(1) };
  }
  return null;
}

// ── shell ────────────────────────────────────────────────────────────────────

function tabbar(path) {
  const active = (href) => {
    const target = href.replace(/^#/, "");
    if (target === "/") return path === "/";
    return path.startsWith(target);
  };

  return h("nav.tabbar", { "aria-label": "Main" },
    // Only visible on desktop, where the bar becomes a left rail.
    h("div.tabbar__brand",
      h("img", { src: "/favicon.svg", alt: "" }),
      "Choopi",
    ),
    ...TABS.map(t => h("a.tabbar__item", {
      href: t.href,
      "aria-current": active(t.href) ? "page" : null,
    }, h("span", { html: icon(t.icon, 22) }), h("span", { text: t.label }))),
  );
}

function topbar({ title, back, right }) {
  return h("header.topbar",
    back && h("button.topbar__back", {
      type: "button", "aria-label": "Back",
      onclick: () => (history.length > 1 ? history.back() : (location.hash = back)),
    }, iconEl("back")),
    h("h1.topbar__title", { text: title }),
    right,
  );
}

function fab() {
  return h("button.fab", {
    type: "button", "aria-label": "Add a data point",
    onclick: () => openQuickAdd({ onDone: () => navigate({ silent: true }) }),
  }, h("span", { html: icon("plus", 28) }));
}

// ── routing ──────────────────────────────────────────────────────────────────

let renderToken = 0;

/**
 * Render the route for the current hash.
 *
 * `silent` re-renders in place after a write, keeping the scroll position —
 * saving a deposit from the dashboard should refresh the numbers, not jump you
 * back to the top of the page.
 */
export async function navigate({ silent = false } = {}) {
  const token = ++renderToken;
  const path = currentPath();
  const match = matchRoute(path);

  if (!match) { location.hash = "#/"; return; }

  const scrollY = silent ? window.scrollY : 0;

  try {
    const view = await match.screen(...match.params);
    if (token !== renderToken) return; // a newer navigation already won

    destroyAll(); // release the outgoing screen's canvases before swapping
    activeCleanup?.();
    activeCleanup = null;
    render(root,
      topbar(view),
      h("main.screen", { id: "main" }, view.node),
      tabbar(path),
      fab(),
    );
    view.mounted?.();
    window.scrollTo({ top: scrollY, behavior: "instant" });
  } catch (err) {
    if (token !== renderToken) return;
    if (err?.status === 401) { start(); return; }
    errorToast(err);
    if (!silent) {
      render(root,
        topbar({ title: "Something went wrong" }),
        h("main.screen",
          h("div.card.stack",
            h("div.card__title", { text: "Couldn't load this screen" }),
            h("p.muted", { text: err.message }),
            h("button.btn.btn--primary", { type: "button", onclick: () => navigate() }, "Try again"),
          ),
        ),
        tabbar(path),
      );
    }
  }
}

/** Re-render after a write, from anywhere. */
export const refresh = () => navigate({ silent: true });

window.addEventListener("hashchange", () => navigate());

// Charts bake their colours in at construction time, so a theme flip has to
// rebuild them.
subscribe((detail) => { if (detail.theme) retheme(); });

// ── start-up ─────────────────────────────────────────────────────────────────

async function start() {
  bootLocal();

  // Registered before the passcode screen: the shell should be cached even on
  // a device that never gets past the lock screen.
  registerServiceWorker();

  let status;
  try {
    status = await api.auth.status();
  } catch (err) {
    render(root, h("main.screen",
      h("div.card.stack",
        h("div.card__title", { text: "Can't reach the server" }),
        h("p.muted", { text: err.message }),
        h("p.faint", { text: "Start it with `npm start` on the machine that hosts it, then reload." }),
        h("button.btn.btn--primary", { type: "button", onclick: () => start() }, "Retry"),
      ),
    ));
    return;
  }

  if (status.setup_required || !status.authenticated) {
    showScreen(loginScreen({
      setupRequired: status.setup_required,
      locked: status.locked,
      retryInSeconds: status.retry_in_seconds,
      onDone: () => start(),
    }));
    return;
  }

  try {
    const { settings } = await api.settings.get();
    applySettings(settings);
  } catch (err) {
    if (err.status === 401) {
      showScreen(loginScreen({ setupRequired: false, onDone: () => start() }));
      return;
    }
    throw err;
  }

  await navigate();

  // Salary deposits post server-side on boot and nightly; nudging on open means
  // a laptop that was closed over the weekend catches up the moment you look.
  api.recurring.generate()
    .then(r => { if (r.created > 0) {
      toast(`Posted ${r.created} scheduled deposit${r.created === 1 ? "" : "s"}`);
      refresh();
    }})
    .catch(() => { /* non-critical; the nightly job will get it */ });
}

start();

export { frag };
