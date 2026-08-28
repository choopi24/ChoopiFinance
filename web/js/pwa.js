/**
 * Service-worker registration and the "installable?" diagnosis.
 *
 * A service worker only runs in a secure context. Over plain http:// on a LAN
 * IP there is no secure context, so registration is not attempted at all —
 * silently failing here is how you end up believing you have an offline app
 * when you have a bookmark. `installState()` reports which of those two worlds
 * the page is in so Settings can say so out loud.
 */

const SW_URL = "/sw.js";

export function isSecureContextish() {
  // localhost is treated as secure by every browser even over http.
  return window.isSecureContext === true;
}

export function installState() {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's own flag, which predates display-mode.
    window.navigator.standalone === true;

  return {
    secure: isSecureContextish(),
    protocol: location.protocol,
    host: location.host,
    serviceWorkerSupported: "serviceWorker" in navigator,
    serviceWorkerActive: Boolean(navigator.serviceWorker?.controller),
    standalone,
  };
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return { ok: false, reason: "unsupported" };
  if (!isSecureContextish()) {
    // Not an error worth shouting about — it's the expected state on http://.
    console.info(
      "[pwa] Not a secure context, so no service worker. " +
      "Serve over HTTPS (npm run setup:https) for a real installable app."
    );
    return { ok: false, reason: "insecure" };
  }

  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });

    // A new worker taking over mid-session would leave the page running old
    // code against a new API, so take the update on the next load instead.
    reg.addEventListener("updatefound", () => {
      const installing = reg.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          console.info("[pwa] Update downloaded — it will apply next time you open the app.");
        }
      });
    });

    return { ok: true, registration: reg };
  } catch (err) {
    console.warn("[pwa] Service worker registration failed:", err);
    return { ok: false, reason: "error", error: err };
  }
}

/** Drop the worker and its caches — the "it's behaving oddly" escape hatch. */
export async function unregisterServiceWorker() {
  if (!("serviceWorker" in navigator)) return false;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map(r => r.unregister()));
  if (window.caches) {
    for (const key of await caches.keys()) {
      if (key.startsWith("choopi-")) await caches.delete(key);
    }
  }
  return true;
}
