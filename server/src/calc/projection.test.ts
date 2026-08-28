import { describe, it, expect } from "vitest";
import { monthlyContributionOf, project } from "./projection.js";

const M = (major: number) => Math.round(major * 100);

/**
 * The tests check the iterative model against CLOSED-FORM compound-interest
 * formulas, computed independently here. If the loop and the textbook agree,
 * the calculator is right; if someone later "simplifies" the loop, these fail.
 */

/** Geometric monthly rate for a stated annual return. */
const monthlyRate = (annualPct: number) => Math.pow(1 + annualPct / 100, 1 / 12) - 1;

describe("project — against closed-form formulas", () => {
  it("lump sum, no fees: FV = PV × (1 + r)^t exactly", () => {
    // ₪100,000 at 8%/year for 10 years.
    const r = project({
      start_value_minor: M(100_000),
      monthly_contribution_minor: 0,
      annual_return_pct: 8,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 0,
      months: 120,
    });
    const expected = 100_000 * Math.pow(1.08, 10); // 215,892.50…
    expect(r.final.value_minor / 100).toBeCloseTo(expected, 2);
    expect(r.final.principal_minor).toBe(M(100_000)); // nothing new contributed
    expect(r.final.fees_minor).toBe(0);
  });

  it("contributions only, no fees: FV = C × ((1+g)^n − 1) / g (ordinary annuity)", () => {
    // ₪1,000/month at 6%/year for 20 years, starting from zero.
    const g = monthlyRate(6);
    const n = 240;
    const r = project({
      start_value_minor: 0,
      monthly_contribution_minor: M(1_000),
      annual_return_pct: 6,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 0,
      months: n,
    });
    const expected = 1_000 * ((Math.pow(1 + g, n) - 1) / g); // ≈ 455,631
    expect(r.final.value_minor / 100).toBeCloseTo(expected, 1);
    expect(r.final.contributed_minor).toBe(M(240_000));
    expect(r.final.principal_minor).toBe(M(240_000));
  });

  it("lump + contributions is the sum of the two (the model is linear)", () => {
    const base = {
      annual_return_pct: 7,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 0,
      months: 180,
    };
    const lump = project({ ...base, start_value_minor: M(50_000), monthly_contribution_minor: 0 });
    const annuity = project({ ...base, start_value_minor: 0, monthly_contribution_minor: M(2_000) });
    const both = project({ ...base, start_value_minor: M(50_000), monthly_contribution_minor: M(2_000) });
    expect(both.final.value_minor)
      .toBeCloseTo(lump.final.value_minor + annuity.final.value_minor, -1); // within ₪0.1
  });

  it("zero return: value is exactly start + contributions, no drift", () => {
    const r = project({
      start_value_minor: M(10_000),
      monthly_contribution_minor: M(500),
      annual_return_pct: 0,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 0,
      months: 36,
    });
    expect(r.final.value_minor).toBe(M(10_000 + 500 * 36));
    expect(r.final.earnings_minor).toBe(0);
  });

  it("a deposit fee skims exactly its percentage off every contribution", () => {
    // 1.49% off ₪1,000/month, no growth: the arithmetic is exact.
    const r = project({
      start_value_minor: 0,
      monthly_contribution_minor: M(1_000),
      annual_return_pct: 0,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 1.49,
      months: 12,
    });
    expect(r.final.value_minor).toBe(Math.round(M(1_000) * 0.9851 * 12));
    expect(r.final.fees_minor).toBe(Math.round(M(1_000) * 0.0149 * 12));
    // Principal counts the GROSS contribution — the fee is part of what it cost you.
    expect(r.final.principal_minor).toBe(M(12_000));
    expect(r.final.earnings_minor).toBe(r.final.value_minor - M(12_000)); // negative: fees, no growth
  });

  it("the balance fee visibly drags a long projection (the reason the estimate exists)", () => {
    const base = {
      start_value_minor: M(200_000),
      monthly_contribution_minor: M(4_200),
      annual_return_pct: 6,
      deposit_fee_pct: 0,
      months: 360,
    };
    const noFee = project({ ...base, annual_balance_fee_pct: 0 });
    const withFee = project({ ...base, annual_balance_fee_pct: 0.62 });

    const drag = noFee.final.value_minor - withFee.final.value_minor;
    // 0.62%/yr over 30 years on a growing balance costs well into six figures.
    expect(drag).toBeGreaterThan(M(100_000));
    // …and the fees the projection reports account for the drag's direct part
    // (the rest is the growth those fees never earned).
    expect(withFee.final.fees_minor).toBeGreaterThan(M(50_000));
    expect(drag).toBeGreaterThan(withFee.final.fees_minor);
  });

  it("holds the app's identity at every emitted point: value = principal + earnings", () => {
    const r = project({
      start_value_minor: M(68_000),
      monthly_contribution_minor: M(1_050),
      annual_return_pct: 5.5,
      annual_balance_fee_pct: 0.85,
      deposit_fee_pct: 1.49,
      months: 240,
      sample_every: 6,
    });
    for (const p of r.points) {
      expect(p.principal_minor + p.earnings_minor).toBe(p.value_minor);
      expect(p.principal_minor).toBe(r.points[0].value_minor + p.contributed_minor);
    }
  });

  it("a negative return shrinks the value and never yields NaN or Infinity", () => {
    const r = project({
      start_value_minor: M(10_000),
      monthly_contribution_minor: 0,
      annual_return_pct: -20,
      annual_balance_fee_pct: 0.5,
      deposit_fee_pct: 0,
      months: 60,
    });
    expect(r.final.value_minor).toBeLessThan(M(10_000));
    expect(r.final.value_minor).toBeGreaterThan(0);
    for (const p of r.points) {
      expect(Number.isFinite(p.value_minor)).toBe(true);
      expect(Number.isFinite(p.earnings_minor)).toBe(true);
    }
  });

  it("months: 0 returns just today", () => {
    const r = project({
      start_value_minor: M(5_000),
      monthly_contribution_minor: M(100),
      annual_return_pct: 6,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 0,
      months: 0,
    });
    expect(r.points).toHaveLength(1);
    expect(r.final.value_minor).toBe(M(5_000));
    expect(r.final.contributed_minor).toBe(0);
  });

  it("sampling emits month 0, every Nth month, and always the final month", () => {
    const r = project({
      start_value_minor: M(1_000),
      monthly_contribution_minor: 0,
      annual_return_pct: 6,
      annual_balance_fee_pct: 0,
      deposit_fee_pct: 0,
      months: 30,
      sample_every: 12,
    });
    expect(r.points.map(p => p.month)).toEqual([0, 12, 24, 30]);
  });

  it("rejects inputs that would produce garbage", () => {
    const ok = {
      start_value_minor: 0, monthly_contribution_minor: 0, annual_return_pct: 5,
      annual_balance_fee_pct: 0, deposit_fee_pct: 0, months: 12,
    };
    expect(() => project({ ...ok, start_value_minor: -1 })).toThrow(/negative/);
    expect(() => project({ ...ok, monthly_contribution_minor: -1 })).toThrow(/negative/);
    expect(() => project({ ...ok, annual_return_pct: -100 })).toThrow(/above/);
    expect(() => project({ ...ok, months: 1201 })).toThrow(/between 0 and 1200/);
    expect(() => project({ ...ok, months: 2.5 })).toThrow(/whole number/);
    expect(() => project({ ...ok, annual_balance_fee_pct: 101 })).toThrow(/between/);
    expect(() => project({ ...ok, annual_return_pct: NaN })).toThrow(/finite/);
  });
});

describe("monthlyContributionOf", () => {
  const rule = (over: Partial<{ frequency: string; amount_minor: number; is_active: number; end_date: string | null }>) =>
    ({ frequency: "monthly", amount_minor: M(1_000), is_active: 1, end_date: null, ...over });

  it("spreads quarterly and annual rules evenly across months", () => {
    const rules = [
      rule({}),                                          // 1,000/mo
      rule({ frequency: "quarterly", amount_minor: M(3_000) }), // +1,000/mo
      rule({ frequency: "annual", amount_minor: M(12_000) }),   // +1,000/mo
    ];
    expect(monthlyContributionOf(rules, "2026-08-28")).toBe(M(3_000));
  });

  it("skips inactive rules and rules that have already ended", () => {
    const rules = [
      rule({}),
      rule({ is_active: 0 }),
      rule({ end_date: "2026-01-31" }), // ended before asOf
      rule({ end_date: "2027-01-31" }), // still running — counts
    ];
    expect(monthlyContributionOf(rules, "2026-08-28")).toBe(M(2_000));
  });
});
