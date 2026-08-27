import { describe, it, expect } from "vitest";
import { xirr } from "./returns.js";
import { safePct, safeRatio, scaleMinor, toMinor } from "./money.js";

const M = toMinor;

describe("xirr", () => {
  it("a single year, doubling: ~100 %/yr", () => {
    const r = xirr([
      { date: "2026-01-01", amount: -M(1_000) },
      { date: "2027-01-01", amount:  M(2_000) },
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(1.0, 3);
  });

  it("flat over a year: ~0 %/yr", () => {
    const r = xirr([
      { date: "2026-01-01", amount: -M(1_000) },
      { date: "2027-01-01", amount:  M(1_000) },
    ]);
    expect(r!).toBeCloseTo(0, 4);
  });

  it("a loss produces a negative rate", () => {
    const r = xirr([
      { date: "2026-01-01", amount: -M(1_000) },
      { date: "2027-01-01", amount:  M(900) },
    ]);
    expect(r!).toBeLessThan(0);
    expect(r!).toBeCloseTo(-0.1, 3);
  });

  it("irregular deposits: the rate reflects WHEN money arrived", () => {
    // 1,000 at the start plus 1,000 at month 11; ends at 2,150.
    // Money-weighted return must exceed the naive 7.5 % total gain, because
    // most of the second deposit had almost no time to work.
    const r = xirr([
      { date: "2026-01-01", amount: -M(1_000) },
      { date: "2026-12-01", amount: -M(1_000) },
      { date: "2027-01-01", amount:  M(2_150) },
    ]);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0.075);
  });

  it("half a year of 10 % annualises to roughly 21 %", () => {
    const r = xirr([
      { date: "2026-01-01", amount: -M(1_000) },
      { date: "2026-07-02", amount:  M(1_100) },
    ]);
    expect(r!).toBeGreaterThan(0.19);
    expect(r!).toBeLessThan(0.23);
  });

  // ── the edge cases the contract promises never to blow up on ──
  it("returns null, never NaN/Infinity, for degenerate inputs", () => {
    expect(xirr([])).toBeNull();                                            // nothing
    expect(xirr([{ date: "2026-01-01", amount: -M(100) }])).toBeNull();     // one flow
    expect(xirr([                                                          // all outflows
      { date: "2026-01-01", amount: -M(100) },
      { date: "2027-01-01", amount: -M(100) },
    ])).toBeNull();
    expect(xirr([                                                          // all inflows
      { date: "2026-01-01", amount: M(100) },
      { date: "2027-01-01", amount: M(100) },
    ])).toBeNull();
    expect(xirr([                                                          // same day
      { date: "2026-01-01", amount: -M(100) },
      { date: "2026-01-01", amount:  M(120) },
    ])).toBeNull();
    expect(xirr([                                                          // zero amounts
      { date: "2026-01-01", amount: 0 },
      { date: "2027-01-01", amount: 0 },
    ])).toBeNull();
  });

  it("survives a total loss without returning -Infinity", () => {
    const r = xirr([
      { date: "2026-01-01", amount: -M(1_000) },
      { date: "2027-01-01", amount: 1 }, // one agora left
    ]);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!)).toBe(true);
    expect(r!).toBeLessThan(-0.9);
  });

  it("every result is finite across a fuzz of plausible ledgers", () => {
    for (let i = 0; i < 300; i++) {
      const flows = [
        { date: "2026-01-01", amount: -Math.round(Math.random() * 1e7) - 1 },
        { date: "2026-06-15", amount: -Math.round(Math.random() * 1e6) },
        { date: "2027-03-01", amount:  Math.round(Math.random() * 2e7) },
      ];
      const r = xirr(flows);
      if (r !== null) expect(Number.isFinite(r)).toBe(true);
    }
  });
});

describe("money guards", () => {
  it("safeRatio / safePct never yield NaN or Infinity", () => {
    expect(safeRatio(100, 0)).toBeNull();
    expect(safePct(100, 0)).toBeNull();
    expect(safeRatio(NaN, 5)).toBeNull();
    expect(safePct(1_300, 10_000)).toBe(13);
  });

  it("scaleMinor rounds symmetrically so a fee and its reversal cancel", () => {
    const fee = scaleMinor(12_345, 0.015);
    const reversal = scaleMinor(-12_345, 0.015);
    expect(fee + reversal).toBe(0);
  });

  it("scaleMinor always returns an integer number of minor units", () => {
    for (const [m, r] of [[100, 3.6], [12_345, 1 / 3], [999, 0.0725]] as const) {
      expect(Number.isInteger(scaleMinor(m, r))).toBe(true);
    }
  });
});
