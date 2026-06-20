import { describe, it, expect } from "vitest";
import {
  validateExpectedAnnualReturn,
  validateMonthlyContribution,
  isError,
} from "./projectionValidation.js";

describe("PATCH validation — expected_annual_return", () => {
  it("accepts a valid decimal rate in range", () => {
    expect(validateExpectedAnnualReturn(0.07)).toEqual({ value: 0.07 });
    expect(validateExpectedAnnualReturn("0.1")).toEqual({ value: 0.1 });
  });

  it("accepts the boundary values -1 and 1", () => {
    expect(validateExpectedAnnualReturn(-1)).toEqual({ value: -1 });
    expect(validateExpectedAnnualReturn(1)).toEqual({ value: 1 });
  });

  it("accepts a negative return (loss assumption)", () => {
    expect(validateExpectedAnnualReturn(-0.2)).toEqual({ value: -0.2 });
  });

  it("clears the field on null or empty string", () => {
    expect(validateExpectedAnnualReturn(null)).toEqual({ value: null });
    expect(validateExpectedAnnualReturn("")).toEqual({ value: null });
    expect(validateExpectedAnnualReturn(undefined)).toEqual({ value: null });
  });

  it("rejects values outside [-1, 1]", () => {
    const tooHigh = validateExpectedAnnualReturn(1.5);
    const tooLow = validateExpectedAnnualReturn(-2);
    expect(isError(tooHigh)).toBe(true);
    expect(isError(tooLow)).toBe(true);
  });

  it("rejects non-numeric input", () => {
    expect(isError(validateExpectedAnnualReturn("abc"))).toBe(true);
  });
});

describe("PATCH validation — monthly_contribution", () => {
  it("accepts a non-negative number", () => {
    expect(validateMonthlyContribution(500)).toEqual({ value: 500 });
    expect(validateMonthlyContribution(0)).toEqual({ value: 0 });
    expect(validateMonthlyContribution("250")).toEqual({ value: 250 });
  });

  it("clears the field on null or empty string", () => {
    expect(validateMonthlyContribution(null)).toEqual({ value: null });
    expect(validateMonthlyContribution("")).toEqual({ value: null });
  });

  it("rejects negative numbers", () => {
    expect(isError(validateMonthlyContribution(-1))).toBe(true);
  });

  it("rejects non-numeric input", () => {
    expect(isError(validateMonthlyContribution("xyz"))).toBe(true);
  });
});
