/**
 * The startup banner.
 *
 * The one thing you actually need at 8am on the sofa is the URL to type into
 * your phone. It is printed once, big, with everything else — protocol, guard
 * state, passcode state, certificate expiry — arranged around it, so a glance
 * tells you whether this boot is healthy.
 */

import { homedir } from "os";
import {
  daysUntilExpiry, lanAddresses, mdnsHostname, primaryLanAddress, type TlsMaterial,
} from "./tls.js";

export interface BannerInfo {
  port: number;
  httpPort: number | null;
  tls: TlsMaterial | null;
  lanOnly: boolean;
  extraRanges: string[];
  pinConfigured: boolean;
  pinFromEnv: boolean;
  dbFile: string;
}

const BOX = 74;

const line = (text = ""): string => {
  // Truncate rather than overflow: a box with one ragged line looks broken.
  const body = text.length > BOX - 2 ? `${text.slice(0, BOX - 5)}...` : text;
  return `│ ${body}${" ".repeat(Math.max(0, BOX - 2 - body.length))} │`;
};

/** Long absolute paths are unreadable in a box; the home prefix is noise. */
function shortPath(p: string): string {
  const home = homedir();
  const rel = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (rel.length <= 58) return rel;
  return `...${rel.slice(-55)}`;
}

const rule = (l: string, r: string) => `${l}${"─".repeat(BOX)}${r}`;

/**
 * The address a phone should use. Prefers the mDNS hostname when the
 * certificate covers it — a name survives a DHCP lease change, an IP does not.
 */
export function phoneUrl(info: BannerInfo): string {
  const scheme = info.tls ? "https" : "http";
  const mdns = mdnsHostname();
  const ip = primaryLanAddress();

  const certCovers = (host: string) =>
    !info.tls || info.tls.hosts.length === 0 || info.tls.hosts.includes(host);

  const host = mdns && certCovers(mdns) ? mdns : ip ?? "localhost";
  return `${scheme}://${host}:${info.port}`;
}

export function renderBanner(info: BannerInfo): string {
  const scheme = info.tls ? "https" : "http";
  const rows: string[] = [];

  rows.push(rule("┌", "┐"));
  rows.push(line("CHOOPI FINANCE"));
  rows.push(rule("├", "┤"));
  rows.push(line());
  rows.push(line("  On your phone, open:"));
  rows.push(line());
  rows.push(line(`      ${phoneUrl(info)}`));
  rows.push(line());

  const addrs = lanAddresses();
  if (addrs.length) {
    rows.push(line("  Also reachable at:"));
    for (const a of addrs) {
      rows.push(line(`      ${scheme}://${a.address}:${info.port}   (${a.iface})`));
    }
  }
  rows.push(line(`      ${scheme}://localhost:${info.port}   (this machine)`));
  rows.push(line());
  rows.push(rule("├", "┤"));

  if (info.tls) {
    const days = daysUntilExpiry(info.tls);
    rows.push(line(`  TLS        HTTPS on — certificate covers ${info.tls.hosts.length} name(s)`));
    if (days != null) {
      rows.push(line(
        `             expires in ${days} day(s)` +
        (days < 30 ? "   <- renew: npm run setup:https" : "")
      ));
    }
    if (info.httpPort != null) {
      const host = primaryLanAddress() ?? "localhost";
      rows.push(line(`             http://${host}:${info.httpPort}/ca  → install the CA on a device`));
    }
  } else {
    rows.push(line("  TLS        OFF — plain HTTP."));
    rows.push(line("             A phone will NOT install this as a real PWA without HTTPS."));
    rows.push(line("             Run:  npm run setup:https"));
  }

  rows.push(line(
    info.lanOnly
      ? `  LAN guard  ON — private ranges + localhost only` +
        (info.extraRanges.length ? ` (+${info.extraRanges.length} extra)` : "")
      : "  LAN guard  OFF — LAN_ONLY=false. Anything that reaches this port is served."
  ));

  rows.push(line(
    info.pinConfigured
      ? `  Passcode   set${info.pinFromEnv ? " (from APP_PIN_HASH)" : " (server/config/pin.json)"}`
      : "  Passcode   NOT SET — the first device to open the app chooses it"
  ));

  rows.push(line(`  Database   ${shortPath(info.dbFile)}`));
  rows.push(line());
  rows.push(line("  Never forward this port on your router. Private network only."));
  rows.push(rule("└", "┘"));

  return rows.join("\n");
}
