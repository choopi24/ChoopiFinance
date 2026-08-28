import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { isPrivateAddress, lanGuard, normalizeIp, parseExtraRanges } from "./lanGuard.js";

describe("normalizeIp", () => {
  it("unwraps the IPv4-mapped form Node reports on a dual-stack socket", () => {
    expect(normalizeIp("::ffff:192.168.1.7")).toBe("192.168.1.7");
    expect(normalizeIp("::FFFF:10.0.0.4")).toBe("10.0.0.4");
  });

  it("strips the brackets from a bracketed IPv6 address", () => {
    expect(normalizeIp("[::1]:51234")).toBe("::1");
  });

  it("passes plain addresses through", () => {
    expect(normalizeIp("192.168.1.7")).toBe("192.168.1.7");
    expect(normalizeIp(undefined)).toBe("");
  });
});

describe("isPrivateAddress", () => {
  it("allows the three RFC1918 ranges and loopback", () => {
    for (const ip of [
      "192.168.0.1", "192.168.255.254",
      "10.0.0.1", "10.255.255.254", "10.100.102.3",
      "172.16.0.1", "172.31.255.254",
      "127.0.0.1", "::1", "::ffff:192.168.1.50",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("refuses public addresses", () => {
    for (const ip of [
      "8.8.8.8", "1.1.1.1", "203.0.113.9",
      "172.15.255.255", "172.32.0.1", // just outside 172.16.0.0/12
      "192.169.0.1", "11.0.0.1",
      "2001:4860:4860::8888",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("treats an unparseable address as not private", () => {
    for (const ip of ["", "not-an-ip", "999.1.1.1", "10.0.0", undefined]) {
      expect(isPrivateAddress(ip as string | undefined), String(ip)).toBe(false);
    }
  });

  it("allows IPv6 unique-local and link-local, which some routers hand out", () => {
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1c2b")).toBe(true);
    expect(isPrivateAddress("fd00::1", { allowIpv6Private: false })).toBe(false);
  });
});

describe("parseExtraRanges", () => {
  it("adds a range that would otherwise be refused (e.g. a Tailscale subnet)", () => {
    const extra = parseExtraRanges("100.64.0.0/10");
    expect(isPrivateAddress("100.101.102.103", { extra })).toBe(true);
    expect(isPrivateAddress("101.0.0.1", { extra })).toBe(false);
  });

  it("defaults a bare address to a /32", () => {
    const extra = parseExtraRanges("203.0.113.5");
    expect(isPrivateAddress("203.0.113.5", { extra })).toBe(true);
    expect(isPrivateAddress("203.0.113.6", { extra })).toBe(false);
  });

  it("rejects nonsense loudly rather than silently allowing nothing", () => {
    expect(() => parseExtraRanges("banana/24")).toThrow(/not a valid IPv4 CIDR/);
    expect(() => parseExtraRanges("10.0.0.0/99")).toThrow(/not a valid IPv4 CIDR/);
  });

  it("is empty for empty input", () => {
    expect(parseExtraRanges(undefined)).toEqual([]);
    expect(parseExtraRanges("  ")).toEqual([]);
  });
});

// ── the middleware ───────────────────────────────────────────────────────────

function call(remoteAddress: string | undefined, enabled = true) {
  const req = { socket: { remoteAddress }, path: "/api/portfolio/summary" } as unknown as Request;
  const res: { statusCode: number; body: string; status: (c: number) => unknown; type: () => unknown; send: (p: string) => unknown } = {
    statusCode: 200,
    body: "",
    status(code: number) { res.statusCode = code; return res; },
    type() { return res; },
    send(payload: string) { res.body = payload; return res; },
  };
  const next = vi.fn();

  lanGuard({ enabled, extra: [] })(req, res as unknown as Response, next);
  return { res, next };
}

describe("lanGuard", () => {
  it("lets a phone on the wifi through", () => {
    const { next, res } = call("192.168.1.42");
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("refuses a public address with 403 and no detail about the app", () => {
    const { next, res } = call("8.8.8.8");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatch(/local network/i);
    expect(res.body).not.toMatch(/choopi|portfolio|api/i);
  });

  it("refuses a request with no source address at all", () => {
    const { next, res } = call(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("passes everything through when disabled", () => {
    const { next } = call("8.8.8.8", false);
    expect(next).toHaveBeenCalledOnce();
  });
});
