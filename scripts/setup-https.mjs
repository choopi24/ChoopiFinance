#!/usr/bin/env node
/**
 * Generate the local HTTPS certificate with mkcert.
 *
 * WHY THIS EXISTS: a service worker — and therefore a real installable PWA —
 * only runs in a "secure context". `http://192.168.1.42:3001` is not one. So
 * the phone needs HTTPS, and HTTPS on a home network needs a certificate that
 * a browser will trust. mkcert makes a private certificate authority that lives
 * only on your machines, and issues a certificate from it.
 *
 * WHAT THIS SCRIPT DOES NOT DO: install the CA into your system trust store.
 * That is `mkcert -install`, it needs your password, and it changes a system
 * security setting — so you run it yourself. This script prints the exact
 * command at the end.
 *
 * Re-run this whenever your LAN IP changes or the certificate nears expiry.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const certsDir = join(root, "server", "certs");

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const green = (s) => `[32m${s}[0m`;
const yellow = (s) => `[33m${s}[0m`;

function fail(message, hint) {
  console.error(`\n${yellow("✗")} ${message}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

// ── 1. mkcert present? ───────────────────────────────────────────────────────

let mkcertVersion;
try {
  mkcertVersion = execFileSync("mkcert", ["-version"], { encoding: "utf8" }).trim();
} catch {
  fail(
    "mkcert is not installed.",
    [
      "  macOS:    brew install mkcert nss",
      "  Windows:  choco install mkcert     (or: scoop bucket add extras; scoop install mkcert)",
      "  Linux:    apt install libnss3-tools, then grab mkcert from",
      "            https://github.com/FiloSottile/mkcert/releases",
      "",
      "  Then run this again:  npm run setup:https",
    ].join("\n")
  );
}

const caRoot = execFileSync("mkcert", ["-CAROOT"], { encoding: "utf8" }).trim();
console.log(`${bold("mkcert")} ${mkcertVersion}`);
console.log(dim(`CA directory: ${caRoot}`));

// ── 2. what names should the certificate cover? ──────────────────────────────

/**
 * Every private IPv4 this machine answers on. A certificate that covers the IP
 * keeps working on Android and older Windows, where .local resolution is
 * unreliable.
 */
function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/**
 * The Bonjour name the machine already answers to. Using the EXISTING name
 * matters: inventing "tracker.local" would need an mDNS responder publishing it
 * and an /etc/hosts entry on every client, whereas this name already resolves
 * from any Apple device on the network with zero setup.
 */
const mdnsName = hostname().endsWith(".local") ? hostname() : `${hostname()}.local`;

const extra = process.argv.slice(2).filter(a => !a.startsWith("-"));
const ips = lanAddresses();
const hosts = [...new Set([mdnsName, ...ips, "localhost", "127.0.0.1", "::1", ...extra])];

if (ips.length === 0) {
  console.warn(yellow("\n⚠ No private LAN address found — are you connected to wifi?"));
  console.warn("  The certificate will still cover localhost and the .local name.\n");
}

console.log(`\n${bold("Certificate will cover:")}`);
for (const h of hosts) console.log(`  · ${h}`);

// ── 3. issue it ──────────────────────────────────────────────────────────────

mkdirSync(certsDir, { recursive: true });
const certFile = join(certsDir, "cert.pem");
const keyFile = join(certsDir, "key.pem");

// mkcert creates the CA on first use even without -install, so this works on a
// clean machine; the CA just isn't trusted anywhere until you install it.
const result = spawnSync(
  "mkcert",
  ["-cert-file", certFile, "-key-file", keyFile, ...hosts],
  { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
);

if (result.status !== 0) {
  fail(
    "mkcert could not issue the certificate.",
    (result.stderr || result.stdout || "").trim()
  );
}

// ── 4. copy the CA so a phone can download it over plain HTTP ────────────────

const caSource = join(caRoot, "rootCA.pem");
if (!existsSync(caSource)) {
  fail("mkcert did not produce a root CA — nothing to hand to your phone.");
}
copyFileSync(caSource, join(certsDir, "rootCA.pem"));

// Never copy rootCA-key.pem anywhere. It is the key that can mint a trusted
// certificate for ANY site, so it stays in mkcert's own directory.

// ── 5. is the CA actually trusted on this machine? ───────────────────────────

let trustedHere = false;
if (process.platform === "darwin") {
  const check = spawnSync("security", ["find-certificate", "-c", "mkcert", "-a"], { encoding: "utf8" });
  trustedHere = check.status === 0 && (check.stdout ?? "").includes("mkcert");
}

console.log(`\n${green("✓")} ${bold("Certificate written")}`);
console.log(`   ${certFile}`);
console.log(`   ${keyFile}`);
console.log(`   ${join(certsDir, "rootCA.pem")}  ${dim("(the CA to install on your devices)")}`);

console.log(`\n${bold("Next steps")}`);
if (!trustedHere) {
  console.log(`\n  ${yellow("1.")} Trust the CA on THIS machine — needs your password, so run it yourself:`);
  console.log(`\n       ${bold("mkcert -install")}\n`);
  console.log(`     ${dim("Adds the mkcert CA to your login keychain / system trust store.")}`);
  console.log(`     ${dim("Nothing else on the internet is affected: this CA only signs")}`);
  console.log(`     ${dim("certificates you generate yourself, on this machine.")}`);
} else {
  console.log(`\n  ${green("1.")} The CA is already trusted on this machine.`);
}
console.log(`\n  2. Start the server:            ${bold("npm start")}`);
console.log(`  3. Trust the CA on your phone:  see ${bold("docs/https-setup.md")}`);
console.log(`     ${dim(`(the server serves it at http://${ips[0] ?? "<lan-ip>"}:3000/ca)`)}`);
console.log("");
