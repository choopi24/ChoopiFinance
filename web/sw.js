/**
 * Service worker — app shell only.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: financial numbers are never served
 * from a cache. Not once, not "just while offline", not stale-while-revalidate.
 * A tracker that shows you last week's balance because the wifi hiccuped is
 * worse than one that shows you an error, because you cannot tell the two apart
 * by looking. So /api/ requests bypass this worker's cache entirely and go
 * straight to the network; if the network is gone, the request fails and the
 * app says so.
 *
 * What IS cached: the shell — HTML, CSS, JS, fonts, icons, Chart.js. Those are
 * static files that only change when the app is redeployed, and caching them is
 * what makes the installed app open instantly.
 *
 * Even the shell uses network-first, not cache-first: the assets are unhashed,
 * so a cache-first worker would happily pin an old build on your phone forever.
 * Network-first means the cache is a fallback for when the Mac is asleep, and
 * nothing more.
 *
 * Bump SHELL_VERSION whenever the shell changes, so old caches are dropped.
 */

const SHELL_VERSION = "v1";
const SHELL_CACHE = `choopi-shell-${SHELL_VERSION}`;

/** Everything needed to render the app with no network at all. */
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/css/tokens.css",
  "/css/app.css",
  "/vendor/chart.umd.js",
  "/fonts/hanken-grotesk-latin.woff2",
  "/fonts/spline-sans-mono-latin.woff2",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/js/theme-boot.js",
  "/js/app.js",
  "/js/api.js",
  "/js/state.js",
  "/js/ui.js",
  "/js/icons.js",
  "/js/fmt.js",
  "/js/labels.js",
  "/js/charts.js",
  "/js/quickadd.js",
  "/js/screens/login.js",
  "/js/screens/dashboard.js",
  "/js/screens/accounts.js",
  "/js/screens/account.js",
  "/js/screens/account-form.js",
  "/js/screens/rsu.js",
  "/js/screens/settings.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Individually, so one 404 during development doesn't fail the whole install.
    await Promise.all(SHELL_ASSETS.map(async (url) => {
      try { await cache.add(new Request(url, { cache: "reload" })); }
      catch { /* a missing shell asset degrades offline, it doesn't break the app */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("choopi-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** Anything whose freshness matters more than its availability. */
function isNeverCached(url) {
  return url.pathname.startsWith("/api/")
      || url.pathname === "/ca"
      || url.pathname === "/ca.txt";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only GET is ever cacheable, and only from this origin.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The whole point: money numbers do not go through the cache.
  if (isNeverCached(url)) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      // Only cache a real success. An error page cached as the shell is how an
      // app becomes permanently broken on one device.
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;

      // A navigation with nothing cached for that exact URL still gets the
      // shell: the app is a hash router, so index.html can render any route.
      if (request.mode === "navigate") {
        const shell = await caches.match("/index.html");
        if (shell) return shell;
      }

      return new Response(
        "Choopi is offline and this file isn't cached.",
        { status: 503, headers: { "Content-Type": "text/plain" } }
      );
    }
  })());
});

/** Lets the page trigger an immediate update instead of waiting for a restart. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
