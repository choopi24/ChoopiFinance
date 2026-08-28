/**
 * LAN-only guard.
 *
 * Refuses any request whose source address is outside the RFC1918 private
 * ranges and loopback. This is a second lock, not the first one: the first is
 * simply never forwarding the port on the router. But a second lock costs
 * nothing and turns a mistaken port-forward, a UPnP surprise or a VPN
 * misconfiguration from "my whole financial history is on the internet" into a
 * 403.
 *
 * Deliberately NOT proxy-aware. `trust proxy` stays off and X-Forwarded-For is
 * ignored, because a header an attacker controls is not evidence of anything.
 * If you ever put this behind a reverse proxy on the same host, the proxy's
 * connection comes from 127.0.0.1 and passes on its own merits.
 */

import type { Request, Response, NextFunction } from "express";

export interface CidrRange {
  label: string;
  contains: (ip: string) => boolean;
}

/** "192.168.1.7" → 3232235783, or null if it isn't a dotted quad. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

function cidr(label: string, base: string, bits: number): CidrRange {
  const baseInt = ipv4ToInt(base)!;
  // >>> 0 keeps the mask unsigned; a /0 would shift by 32, which JS treats as 0.
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (baseInt & mask) >>> 0;
  return {
    label,
    contains: (ip) => {
      const n = ipv4ToInt(ip);
      return n != null && ((n & mask) >>> 0) === network;
    },
  };
}

/** The ranges a home network actually uses, plus loopback. */
export const PRIVATE_RANGES: CidrRange[] = [
  cidr("192.168.0.0/16", "192.168.0.0", 16),
  cidr("10.0.0.0/8", "10.0.0.0", 8),
  cidr("172.16.0.0/12", "172.16.0.0", 12),
  cidr("127.0.0.0/8 (localhost)", "127.0.0.0", 8),
];

/**
 * Normalise what Node hands us into a bare address.
 * Node reports IPv4 clients on a dual-stack socket as "::ffff:192.168.1.7".
 */
export function normalizeIp(raw: string | undefined): string {
  if (!raw) return "";
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]")); // [::1]:port
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  return ip.toLowerCase();
}

/** IPv6 loopback and, when enabled, the IPv6 private equivalents. */
function isIpv6Local(ip: string, allowIpv6Private: boolean): boolean {
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (!allowIpv6Private) return false;
  // fc00::/7 unique-local, fe80::/10 link-local — some routers hand these out.
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

export function isPrivateAddress(
  raw: string | undefined,
  { allowIpv6Private = true, extra = [] as CidrRange[] } = {}
): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return false;
  if (ip.includes(":")) return isIpv6Local(ip, allowIpv6Private);
  return PRIVATE_RANGES.some(r => r.contains(ip)) || extra.some(r => r.contains(ip));
}

/** Parse LAN_ALLOW_EXTRA="100.64.0.0/10,203.0.113.5/32" into ranges. */
export function parseExtraRanges(spec: string | undefined): CidrRange[] {
  if (!spec?.trim()) return [];
  const out: CidrRange[] = [];
  for (const entry of spec.split(",")) {
    const text = entry.trim();
    if (!text) continue;
    const [base, bitsRaw] = text.split("/");
    const bits = bitsRaw == null ? 32 : Number(bitsRaw);
    if (ipv4ToInt(base) == null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
      throw new Error(`LAN_ALLOW_EXTRA: "${text}" is not a valid IPv4 CIDR`);
    }
    out.push(cidr(text, base, bits));
  }
  return out;
}

export interface LanGuardOptions {
  enabled: boolean;
  extra: CidrRange[];
  onReject?: (ip: string, path: string) => void;
}

/** Read the guard's configuration from the environment. Default: ON. */
export function lanGuardConfig(): LanGuardOptions {
  // Only an explicit "false" disables it. A typo leaves the guard ON, which is
  // the direction a mistake should fail in.
  const enabled = String(process.env.LAN_ONLY ?? "true").toLowerCase() !== "false";
  return { enabled, extra: parseExtraRanges(process.env.LAN_ALLOW_EXTRA) };
}

export function lanGuard(options: LanGuardOptions) {
  if (!options.enabled) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // socket.remoteAddress, not req.ip: req.ip can be influenced by proxy
    // settings, and the socket cannot lie about where the bytes came from.
    const raw = req.socket.remoteAddress;
    if (isPrivateAddress(raw, { extra: options.extra })) {
      next();
      return;
    }

    const ip = normalizeIp(raw) || "unknown";
    options.onReject?.(ip, req.path);
    // No app details, no hint that anything interesting is here.
    res.status(403).type("text/plain").send("Forbidden: this server only answers on the local network.\n");
  };
}
