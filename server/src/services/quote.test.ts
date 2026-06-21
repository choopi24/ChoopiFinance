import { describe, it, expect } from "vitest";
import { getQuote, QuoteUnavailableError } from "./quote.js";

// ── Helpers: fake providers (no network) ───────────────────────────────────────

/** Fake fetch that maps URL substrings → JSON responses. */
function fakeFetch(routes: { match: string; ok?: boolean; body: unknown }[]): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const hit = routes.find(r => u.includes(r.match));
    if (!hit) return { ok: false, json: async () => ({}) } as Response;
    return { ok: hit.ok ?? true, json: async () => hit.body } as Response;
  }) as unknown as typeof fetch;
}

// CoinGecko BTC: search resolves id, then simple/price returns usd.
const cgBtcOk = fakeFetch([
  { match: "/search", body: { coins: [{ id: "bitcoin", symbol: "btc" }] } },
  { match: "/simple/price", body: { bitcoin: { usd: 50000 } } },
]);

// ── Crypto ──────────────────────────────────────────────────────────────────────

describe("getQuote — crypto", () => {
  it("resolve success: returns { symbol, price, currency, name, as_of }", async () => {
    const q = await getQuote("btc", "crypto", undefined, { fetchImpl: cgBtcOk });
    expect(q.symbol).toBe("BTC");
    expect(q.price).toBe(50000);
    expect(q.currency).toBe("USD");
    expect(q.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof q.name).toBe("string");
  });

  it("resolve failure: unknown coin throws QuoteUnavailableError", async () => {
    const noCoin = fakeFetch([{ match: "/search", body: { coins: [] } }]);
    await expect(getQuote("zzzz", "crypto", undefined, { fetchImpl: noCoin }))
      .rejects.toBeInstanceOf(QuoteUnavailableError);
  });

  it("historical: uses /history and returns the requested date", async () => {
    const cgHist = fakeFetch([
      { match: "/search", body: { coins: [{ id: "bitcoin", symbol: "btc" }] } },
      { match: "/history", body: { name: "Bitcoin", market_data: { current_price: { usd: 42000 } } } },
    ]);
    const q = await getQuote("btc", "crypto", "2024-01-15", { fetchImpl: cgHist });
    expect(q.price).toBe(42000);
    expect(q.as_of).toBe("2024-01-15");
    expect(q.name).toBe("Bitcoin");
  });
});

// ── Stock / ETF ───────────────────────────────────────────────────────────────

describe("getQuote — stock/etf", () => {
  it("resolve success: maps a Yahoo quote to the result shape", async () => {
    const yahoo = {
      quote: async () => ({ regularMarketPrice: 298.01, currency: "usd", longName: "Apple Inc." }),
    };
    const q = await getQuote("AAPL", "stock", undefined, { yahoo });
    expect(q).toMatchObject({ symbol: "AAPL", price: 298.01, currency: "USD", name: "Apple Inc." });
    expect(q.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolve failure: no price → QuoteUnavailableError with a helpful message", async () => {
    const yahoo = { quote: async () => ({}) };
    await expect(getQuote("SOMEFUND", "etf", undefined, { yahoo }))
      .rejects.toBeInstanceOf(QuoteUnavailableError);
  });

  it("resolve failure: provider throws → QuoteUnavailableError (not a raw throw)", async () => {
    const yahoo = { quote: async () => { throw new Error("network"); } };
    await expect(getQuote("XYZ.TA", "stock", undefined, { yahoo }))
      .rejects.toBeInstanceOf(QuoteUnavailableError);
  });

  it("historical: reads the first close from the chart window", async () => {
    const yahoo = {
      chart: async () => ({
        meta: { currency: "USD" },
        quotes: [
          { date: new Date("2024-01-13T00:00:00Z"), close: null },
          { date: new Date("2024-01-15T00:00:00Z"), close: 185.5 },
        ],
      }),
    };
    const q = await getQuote("AAPL", "stock", "2024-01-13", { yahoo });
    expect(q.price).toBe(185.5);
    expect(q.as_of).toBe("2024-01-15");
  });
});
