import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinanceClass as any)();
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { getQuote, QuoteUnavailableError, type AssetMarketType } from "../services/quote.js";

export const lookupRouter = Router();
lookupRouter.use(requireAuth);

const MARKET_TYPES = new Set(["crypto", "stock", "etf"]);

// GET /api/lookup/quote?ticker=VOO&type=etf[&date=YYYY-MM-DD]
// Single live (or historical) quote used to derive units for value-based entry.
// Returns { symbol, price, currency, name, as_of }. 404 if the ticker can't be priced.
lookupRouter.get("/quote", async (req, res) => {
  const ticker = String(req.query.ticker ?? "").trim();
  const type = String(req.query.type ?? "");
  const date = req.query.date ? String(req.query.date) : undefined;

  if (!ticker) return fail(res, "ticker is required");
  if (!MARKET_TYPES.has(type)) return fail(res, "type must be one of: crypto, stock, etf");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, "date must be YYYY-MM-DD");
  if (date && new Date(`${date}T00:00:00Z`) > new Date()) return fail(res, "date cannot be in the future");

  try {
    const quote = await getQuote(ticker, type as AssetMarketType, date);
    ok(res, quote);
  } catch (e) {
    if (e instanceof QuoteUnavailableError) return fail(res, e.message, 404);
    fail(res, `Quote lookup failed: ${(e as Error).message}`, 500);
  }
});

interface SearchHit {
  symbol: string;
  name: string;
  type: "stock" | "etf" | "crypto";
  currency: string | null;
  exchange: string | null;
}

// GET /api/lookup/search?q=<text>&type=<crypto|stock|etf>
// Typeahead suggestions for the add form. Fails soft (returns []), since it's
// a non-critical convenience — the user can always type the ticker manually.
lookupRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const type = String(req.query.type ?? "");
  if (q.length < 2) return ok(res, [] as SearchHit[]);

  try {
    if (type === "crypto") {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`,
        { signal: AbortSignal.timeout(5_000) }
      );
      if (!r.ok) return ok(res, [] as SearchHit[]);
      const data = await r.json() as { coins?: { symbol: string; name: string }[] };
      const hits: SearchHit[] = (data.coins ?? []).slice(0, 8).map(c => ({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        type: "crypto",
        currency: "USD",
        exchange: null,
      }));
      return ok(res, hits);
    }

    // stock / etf via Yahoo. validateResult:false → return data instead of throwing
    // on Yahoo's frequently-changing response shape.
    const search = await yahooFinance.search(q, {}, { validateResult: false }) as { quotes?: Record<string, unknown>[] };
    const wantEtf = type === "etf";
    const hits: SearchHit[] = (search.quotes ?? [])
      .filter(x => {
        const qt = String(x.quoteType ?? "").toUpperCase();
        if (!x.symbol) return false;
        return wantEtf
          ? (qt === "ETF" || qt === "MUTUALFUND" || qt === "FUND")
          : (qt === "EQUITY" || qt === "ETF"); // stocks: allow ETFs too, they're close
      })
      .slice(0, 8)
      .map(x => {
        const qt = String(x.quoteType ?? "").toUpperCase();
        return {
          symbol: String(x.symbol),
          name: String(x.longname ?? x.shortname ?? x.symbol),
          type: (qt === "EQUITY" ? "stock" : "etf") as "stock" | "etf",
          currency: (x.currency as string | undefined)?.toUpperCase() ?? null,
          exchange: (x.exchange as string | undefined) ?? null,
        };
      });
    return ok(res, hits);
  } catch {
    return ok(res, [] as SearchHit[]); // fail soft
  }
});

// GET /api/lookup/isin/:isin
// Searches Yahoo Finance by ISIN, returns name, ticker, currency, etf_kind.
lookupRouter.get("/isin/:isin", async (req, res) => {
  const { isin } = req.params;

  if (!/^[A-Z]{2}[A-Z0-9]{10}$/.test(isin.toUpperCase())) {
    return fail(res, "Invalid ISIN format (expect 12 chars: 2-letter country + 10 alphanumeric)");
  }

  try {
    const search = await yahooFinance.search(isin.toUpperCase(), {}, { validateResult: false }) as { quotes?: Record<string, unknown>[] };
    const hit = search.quotes?.[0];

    if (!hit || !hit.symbol) {
      return fail(res, "No security found for this ISIN", 404);
    }

    const symbol = hit.symbol as string;

    // Get a richer quote for name + currency
    const quote = await yahooFinance.quote(symbol, {}, { validateResult: false }) as Record<string, unknown>;

    const name: string = (
      (quote.longName as string | undefined) ??
      (quote.shortName as string | undefined) ??
      (hit.longname as string | undefined) ??
      (hit.shortname as string | undefined) ??
      symbol
    );
    const currency: string = ((quote.currency as string | undefined) ?? "USD").toUpperCase();
    const quoteType: string = ((quote.quoteType as string | undefined) ?? "").toLowerCase();

    // Detect ETF kind from security name (heuristic)
    const lname = name.toLowerCase();
    let etf_kind: string | null = null;
    if (lname.includes("acc") || lname.includes("accumul") || lname.includes("capitaliz")) {
      etf_kind = "accumulating";
    } else if (
      lname.includes("dist") ||
      lname.includes("distribut") ||
      lname.includes("income") ||
      lname.includes("dividend")
    ) {
      etf_kind = "distributing";
    }

    // Map Yahoo quoteType → our asset type
    const typeMap: Record<string, string> = {
      equity: "stock",
      etf:    "etf",
      mutualfund: "etf",
      fund:   "etf",
    };
    const assetType = typeMap[quoteType] ?? "stock";

    ok(res, {
      isin: isin.toUpperCase(),
      symbol,
      name,
      currency,
      etf_kind,
      asset_type: assetType,
      exchange: (quote.exchange as string | undefined) ?? null,
    });
  } catch (e) {
    fail(res, `ISIN lookup failed: ${(e as Error).message}`, 500);
  }
});
