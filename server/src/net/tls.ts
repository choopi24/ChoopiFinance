/**
 * Locating the TLS material.
 *
 * Certificates are OPTIONAL. If server/certs/{cert,key}.pem exist the server
 * serves HTTPS; if they don't it serves plain HTTP and says so. This is what
 * lets `npm start` work on a fresh clone with no setup, while a phone that
 * wants a real installable PWA gets a secure context once you have run
 * `npm run setup:https`.
 */

import { X509Certificate } from "crypto";
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { hostname, networkInterfaces } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CERTS_DIR = join(__dirname, "../../certs");

export const certPath = () => process.env.TLS_CERT?.trim() || join(CERTS_DIR, "cert.pem");
export const keyPath = () => process.env.TLS_KEY?.trim() || join(CERTS_DIR, "key.pem");
/** A copy of the mkcert root CA, so a phone can fetch it over plain HTTP. */
export const caPath = () => join(CERTS_DIR, "rootCA.pem");

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  certFile: string;
  keyFile: string;
  /** Names and addresses the certificate is actually valid for. */
  hosts: string[];
  notAfter: Date | null;
}

/** Pull the SANs and expiry out of the certificate for the startup banner. */
function describeCert(pem: Buffer): { hosts: string[]; notAfter: Date | null } {
  try {
    // node:crypto's X509Certificate — no parsing library, no dependency.
    const x = new X509Certificate(pem);
    const hosts = (x.subjectAltName ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => s.replace(/^(DNS|IP Address|IP):/i, "").trim());
    return { hosts, notAfter: x.validTo ? new Date(x.validTo) : null };
  } catch {
    return { hosts: [], notAfter: null };
  }
}

export function loadTls(): TlsMaterial | null {
  const certFile = certPath();
  const keyFile = keyPath();
  if (!existsSync(certFile) || !existsSync(keyFile)) return null;

  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);
  const { hosts, notAfter } = describeCert(cert);
  return { cert, key, certFile, keyFile, hosts, notAfter };
}

export const hasCa = (): boolean => existsSync(caPath());

/** Days until the certificate expires, or null when it can't be read. */
export function daysUntilExpiry(tls: TlsMaterial | null): number | null {
  if (!tls?.notAfter || Number.isNaN(tls.notAfter.getTime())) return null;
  return Math.floor((tls.notAfter.getTime() - Date.now()) / 86_400_000);
}

export interface LanAddress { iface: string; address: string }

/** Every non-loopback IPv4 address this machine answers on. */
export function lanAddresses(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ iface, address: a.address });
    }
  }
  return out;
}

/** The address most likely to be the one a phone should use. */
export function primaryLanAddress(): string | null {
  const all = lanAddresses();
  // en0 first on macOS, then anything in a private range, then anything at all.
  return all.find(a => a.iface === "en0")?.address
    ?? all.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address
    ?? all[0]?.address
    ?? null;
}

/** The Bonjour/mDNS name this machine already answers to, e.g. "mac-mini.local". */
export function mdnsHostname(): string | null {
  const host = process.env.MDNS_HOST?.trim() || hostname();
  return typeof host === "string" && host.endsWith(".local") ? host : null;
}
