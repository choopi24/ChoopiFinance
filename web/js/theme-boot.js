/**
 * Sets the theme attribute before first paint, so a dark-mode phone never
 * flashes a white page while the module graph loads.
 *
 * A separate classic script rather than an inline one: the server's CSP is
 * `script-src 'self'`, and adding 'unsafe-inline' to keep six lines inline
 * would weaken the policy for the whole app.
 */
(function () {
  var stored = null;
  try { stored = localStorage.getItem("choopi.theme"); } catch (e) { /* private mode */ }
  var dark = stored === "dark" ||
    ((!stored || stored === "system") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
