/**
 * Copies Chart.js and the two webfonts out of node_modules into web/.
 *
 * The app is served as plain static files with no bundler, and HARD RULE 1 says
 * nothing may be fetched at runtime — so vendor assets are vendored, literally.
 * Run by `npm run assets`, and by `postinstall` so a fresh clone just works.
 */

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");

const ASSETS = [
  ["node_modules/chart.js/dist/chart.umd.js", "vendor/chart.umd.js"],
  ["node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2",
   "fonts/hanken-grotesk-latin.woff2"],
  ["node_modules/@fontsource-variable/spline-sans-mono/files/spline-sans-mono-latin-wght-normal.woff2",
   "fonts/spline-sans-mono-latin.woff2"],
];

let copied = 0;
const missing = [];

for (const [from, to] of ASSETS) {
  const src = join(root, from);
  const dest = join(web, to);
  if (!existsSync(src)) { missing.push(from); continue; }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  copied++;
}

console.log(`[assets] copied ${copied}/${ASSETS.length} into web/`);
if (missing.length) {
  console.warn(`[assets] missing (run npm install): \n  ${missing.join("\n  ")}`);
  process.exitCode = 1;
}
