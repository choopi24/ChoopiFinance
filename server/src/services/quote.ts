/**
 * On-demand single-quote lookup used by value-based entry (derive units from a
 * fetched price). This is separate from the batch price_cache refresh — it does
 * not write to the DB; it just answers "what is X worth (now, or on a date)?".
 *
 *   stock / etf → yahoo-finance2 (quote for today, chart for a historical date)
 *   crypto      → CoinGecko (simple/price for today, /coins/{id}/history for a date)
 *
 * All external clients are injectable so the resolve-success / resolve-failure
 * shapes can be unit-tested without hitting the network.
 */

import YahooFinanceClass from "yahoo-finance2";
import { resolveCoinGeckoId } from "./prices.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defaultYahoo = new (YahooFinanceClass as any)();

export type AssetMarketType = "crypto" | "stock" | "etf";

export interface QuoteResult {
  symbol: string;
  price: number;
  currency: string;
  name: string;
  as_of: string; // ISO date (YYYY-MM-DD) the price corresponds to
}

/** Thrown when the ticker can't be resolved to a live/historical price. */
export class QuoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteUnavailableError";
  }
}

// Minimal shapes of what we use from the providers (keeps deps injectable).
export interface QuoteDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yahoo?: any;
  fetchImpl?: typeof fetch;
}

const ISO = (d: Date) => d.toISOString().slice(0, 10);

// CoinGecko history wants DD-MM-YYYY; we accept YYYY-MM-DD everywhere else.
function toCoinGeckoDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// ── Stock / ETF via Yahoo ──────────────────────────────────────────────────────

async function quoteStock(
  ticker: string,
  date: string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yahoo: any
): Promise<QuoteResult> {
  if (date) {
    // Historical close via chart (a small window around the date).
    const start = new Date(`${date}T00:00:00Z`);
    const end = new Date(start.getTime() + 5 * 86_400_000); // +5d to be safe across weekends/holidays
    let chart: { quotes?: { date: Date; close: number | null }[]; meta?: { currency?: string } } | null = null;
    try {
      chart = await yahoo.chart(ticker, { period1: start, period2: end, interval: "1d" }, { validateResult: false });
    } catch {
      chart = null;
    }
    const row = chart?.quotes?.find(q => q.close != null);
    if (!row || row.close == null) {
      throw new QuoteUnavailableError(`No historical price for "${ticker}" around ${date}.`);
    }
    return {
      symbol: ticker.toUpperCase(),
      price: row.close,
      currency: (chart?.meta?.currency ?? "USD").toUpperCase(),
      name: ticker.toUpperCase(),
      as_of: ISO(new Date(row.date)),
    };
  }

  let quote: { regularMarketPrice?: number; currency?: string; longName?: string; shortName?: string } | null = null;
  try {
    quote = await yahoo.quote(ticker, {}, { validateResult: false });
  } catch {
    quote = null;
  }
  if (!quote || quote.regularMarketPrice == null) {
    throw new QuoteUnavailableError(
      `Live pricing isn't available for "${ticker}". For an Israeli (TASE) symbol try adding the .TA suffix; some local funds aren't covered.`
    );
  }
  return {
    symbol: ticker.toUpperCase(),
    price: quote.regularMarketPrice,
    currency: (quote.currency ?? "USD").toUpperCase(),
    name: quote.longName ?? quote.shortName ?? ticker.toUpperCase(),
    as_of: ISO(new Date()),
  };
}

// ── Crypto via CoinGecko ───────────────────────────────────────────────────────

async function quoteCrypto(
  ticker: string,
  date: string | undefined,
  fetchImpl: typeof fetch
): Promise<QuoteResult> {
  const id = await resolveCoinGeckoId(ticker, fetchImpl);
  if (!id) {
    throw new QuoteUnavailableError(`Live pricing isn't available for "${ticker}" — coin not found on CoinGecko.`);
  }

  if (date) {
    const resp = await fetchImpl(
      `https://api.coingecko.com/api/v3/coins/${id}/history?date=${toCoinGeckoDate(date)}&localization=false`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!resp.ok) throw new QuoteUnavailableError(`No historical price for "${ticker}" on ${date}.`);
    const data = await resp.json() as {
      name?: string;
      market_data?: { current_price?: { usd?: number } };
    };
    const price = data.market_data?.current_price?.usd;
    if (price == null) throw new QuoteUnavailableError(`No historical price for "${ticker}" on ${date}.`);
    return {
      symbol: ticker.toUpperCase(),
      price,
      currency: "USD",
      name: data.name ?? ticker.toUpperCase(),
      as_of: date,
    };
  }

  const resp = await fetchImpl(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!resp.ok) throw new QuoteUnavailableError(`Couldn't fetch a live price for "${ticker}".`);
  const data = await resp.json() as Record<string, { usd?: number }>;
  const price = data[id]?.usd;
  if (price == null) throw new QuoteUnavailableError(`Couldn't fetch a live price for "${ticker}".`);
  return {
    symbol: ticker.toUpperCase(),
    price,
    currency: "USD",
    name: ticker.toUpperCase(),
    as_of: ISO(new Date()),
  };
}

// ── Public API ──────────────────────────────────────────────────────────────────

export async function getQuote(
  ticker: string,
  type: AssetMarketType,
  date?: string,
  deps: QuoteDeps = {}
): Promise<QuoteResult> {
  const t = ticker.trim();
  if (!t) throw new QuoteUnavailableError("Ticker is required.");
  const yahoo = deps.yahoo ?? defaultYahoo;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (type === "crypto") return quoteCrypto(t, date, fetchImpl);
  return quoteStock(t, date, yahoo);
}
