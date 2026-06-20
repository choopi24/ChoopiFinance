import { describe, it, expect } from "vitest";
import { projectFutureValue } from "./projection";

describe("projectFutureValue — structure", () => {
  it("returns one point per year, 0..years inclusive", () => {
    const series = projectFutureValue({ presentValue: 1000, annualReturn: 0.05, years: 5 });
    expect(series).toHaveLength(6);
    expect(series.map(p => p.year)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("year 0 is exactly the present value", () => {
    const series = projectFutureValue({ presentValue: 12345, annualReturn: 0.08, years: 3 });
    expect(series[0]).toEqual({ year: 0, value: 12345 });
  });

  it("years = 0 yields a single present-value point", () => {
    expect(projectFutureValue({ presentValue: 500, annualReturn: 0.07, years: 0 }))
      .toEqual([{ year: 0, value: 500 }]);
  });
});

describe("projectFutureValue — known values (continuous compounding)", () => {
  it("100k @ 7% for 10y, PMT=0 → ~201,375 (100000·e^0.7)", () => {
    const series = projectFutureValue({ presentValue: 100_000, annualReturn: 0.07, years: 10 });
    expect(series.at(-1)!.value).toBeCloseTo(201_375.27, 2);
  });

  it("with monthly contributions: 10k @ 7% + 500/mo for 10y → ~107,031", () => {
    const series = projectFutureValue({
      presentValue: 10_000,
      annualReturn: 0.07,
      monthlyContribution: 500,
      years: 10,
    });
    expect(series.at(-1)!.value).toBeCloseTo(107_030.62, 2);
  });
});

describe("projectFutureValue — r = 0 edge case", () => {
  it("no growth: FV = PV + PMT*n (n in months)", () => {
    const series = projectFutureValue({
      presentValue: 1000,
      annualReturn: 0,
      monthlyContribution: 100,
      years: 2,
    });
    expect(series).toEqual([
      { year: 0, value: 1000 },
      { year: 1, value: 2200 }, // 1000 + 100*12
      { year: 2, value: 3400 }, // 1000 + 100*24
    ]);
  });

  it("r = 0 with no contribution stays flat", () => {
    const series = projectFutureValue({ presentValue: 5000, annualReturn: 0, years: 3 });
    expect(series.every(p => p.value === 5000)).toBe(true);
  });
});

describe("projectFutureValue — negative return", () => {
  it("declines under a negative rate (-10% for 1y → ~904.84, 1000·e^-0.1)", () => {
    const series = projectFutureValue({ presentValue: 1000, annualReturn: -0.1, years: 1 });
    expect(series.at(-1)!.value).toBeCloseTo(904.84, 2);
    expect(series.at(-1)!.value).toBeLessThan(1000);
  });

  it("is monotonically decreasing each year with PMT=0 and negative return", () => {
    const series = projectFutureValue({ presentValue: 1000, annualReturn: -0.2, years: 5 });
    for (let i = 1; i < series.length; i++) {
      expect(series[i].value).toBeLessThan(series[i - 1].value);
    }
  });
});
