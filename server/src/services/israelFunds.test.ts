import { describe, it, expect } from "vitest";
import {
  estimateIlFundValue,
  searchIlFunds,
  datasetForType,
} from "./israelFunds.js";

describe("datasetForType", () => {
  it("maps types to regulator datasets", () => {
    expect(datasetForType("pension")).toBe("pensia");
    expect(datasetForType("gemel")).toBe("gemel");
    expect(datasetForType("education")).toBe("gemel");
    expect(datasetForType("money_market")).toBeNull(); // ISA mutual funds, not covered
    expect(datasetForType("stock")).toBeNull();
  });
});

describe("estimateIlFundValue", () => {
  it("balance from the current month → nothing to estimate", () => {
    const r = estimateIlFundValue({
      last_balance: 100_000,
      last_balance_at: "2026-07-01T00:00:00Z",
      yields: new Map(),
      now: new Date("2026-07-15T00:00:00Z"),
    });
    expect(r.months_applied).toBe(0);
    expect(r.value).toBe(100_000);
  });

  it("applies published monthly yields compounded", () => {
    // Balance from April, now July → fold May, June, July.
    const r = estimateIlFundValue({
      last_balance: 100_000,
      last_balance_at: "2026-04-20T00:00:00Z",
      yields: new Map([
        [202605, 1.0],   // +1%
        [202606, -0.5],  // −0.5%
      ]),                 // July not published yet
      now: new Date("2026-07-15T00:00:00Z"),
    });
    expect(r.months_applied).toBe(3);
    expect(r.months_with_yield).toBe(2);
    expect(r.value).toBeCloseTo(100_000 * 1.01 * 0.995, 6);
  });

  it("year boundary: December → January period rollover", () => {
    const r = estimateIlFundValue({
      last_balance: 10_000,
      last_balance_at: "2025-11-30T00:00:00Z",
      yields: new Map([
        [202512, 2.0],
        [202601, 1.0],
      ]),
      now: new Date("2026-01-20T00:00:00Z"),
    });
    expect(r.months_applied).toBe(2);
    expect(r.value).toBeCloseTo(10_000 * 1.02 * 1.01, 6);
  });

  it("deducts personal balance fee monthly and adds deposits net of deposit fee", () => {
    // One month: yield +1%, balance fee 1.2%/yr (0.1%/mo), deposit 1000 at 2% fee.
    const r = estimateIlFundValue({
      last_balance: 100_000,
      last_balance_at: "2026-05-15T00:00:00Z",
      yields: new Map([[202606, 1.0]]),
      monthly_deposit: 1_000,
      fee_deposit_pct: 2,
      fee_balance_pct: 1.2,
      now: new Date("2026-06-20T00:00:00Z"),
    });
    const expected = 100_000 * 1.01 * (1 - 0.012 / 12) + 1_000 * 0.98;
    expect(r.value).toBeCloseTo(expected, 6);
  });

  it("months without published yield still accrue deposits", () => {
    const r = estimateIlFundValue({
      last_balance: 50_000,
      last_balance_at: "2026-04-10T00:00:00Z",
      yields: new Map(),  // regulator lag — nothing published
      monthly_deposit: 2_000,
      now: new Date("2026-06-20T00:00:00Z"),
    });
    expect(r.months_applied).toBe(2);
    expect(r.months_with_yield).toBe(0);
    expect(r.value).toBeCloseTo(54_000, 6);
  });
});

describe("searchIlFunds — response parsing", () => {
  const record = (over: Record<string, unknown>) => ({
    FUND_ID: 964,
    FUND_NAME: "הפניקס השתלמות כללי",
    FUND_CLASSIFICATION: "קרן השתלמות",
    MANAGING_CORPORATION: "הפניקס",
    REPORT_PERIOD: 202601,
    MONTHLY_YIELD: 1.5,
    YEAR_TO_DATE_YIELD: 1.5,
    AVG_ANNUAL_MANAGEMENT_FEE: 0.68,
    AVG_DEPOSIT_FEE: 0,
    ...over,
  });

  const fakeFetch = (records: unknown[]) =>
    (async () => ({
      ok: true,
      json: async () => ({ success: true, result: { records } }),
    })) as unknown as typeof fetch;

  it("dedupes to the latest REPORT_PERIOD per fund", async () => {
    const hits = await searchIlFunds("gemel", "הפניקס", fakeFetch([
      record({ REPORT_PERIOD: 202512, MONTHLY_YIELD: 9.9 }),
      record({ REPORT_PERIOD: 202603, MONTHLY_YIELD: 0.4 }),
      record({ REPORT_PERIOD: 202601 }),
      record({ FUND_ID: 1000, FUND_NAME: "אחר", REPORT_PERIOD: 202602 }),
    ]));
    expect(hits).toHaveLength(2);
    const phoenix = hits.find(h => h.fund_id === 964)!;
    expect(phoenix.latest_period).toBe(202603);
    expect(phoenix.monthly_yield).toBe(0.4);
    expect(phoenix.avg_annual_mgmt_fee).toBe(0.68);
  });

  it("propagates HTTP errors (route layer fails soft)", async () => {
    const failingFetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(searchIlFunds("gemel", "x", failingFetch)).rejects.toThrow("HTTP 500");
  });
});
