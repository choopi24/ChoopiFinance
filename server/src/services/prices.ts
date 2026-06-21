/**
 * Price fetching service.
 *
 * Crypto  → CoinGecko free public API (batched, 5-min TTL)
 * Stock / ETF → yahoo-finance2 (per-ticker, 15-min TTL)
 *
 * All prices are stored in price_cache in the asset's native currency.
 * The portfolio layer handles NIS conversion using fx_cache.
 */

import YahooFinanceClass from "yahoo-finance2";
// v3: default export is the class, must be instantiated
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = new (YahooFinanceClass as any)();
import type Database from "better-sqlite3";
import { getRate } from "./fx.js";

// ── TTLs ──────────────────────────────────────────────────────────────────────

const CRYPTO_TTL_MS = 5 * 60 * 1_000;
const STOCK_TTL_MS  = 15 * 60 * 1_000;

// ── CoinGecko symbol → ID mapping ────────────────────────────────────────────

const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",        ETH: "ethereum",       SOL: "solana",
  BNB: "binancecoin",    XRP: "ripple",          ADA: "cardano",
  AVAX: "avalanche-2",   DOGE: "dogecoin",       TRX: "tron",
  DOT: "polkadot",       MATIC: "matic-network", POL: "matic-network",
  LINK: "chainlink",     TON: "the-open-network",SHIB: "shiba-inu",
  LTC: "litecoin",       BCH: "bitcoin-cash",    ATOM: "cosmos",
  UNI: "uniswap",        XMR: "monero",          ETC: "ethereum-classic",
  XLM: "stellar",        ICP: "internet-computer",FIL: "filecoin",
  APT: "aptos",          SUI: "sui",              NEAR: "near",
  ALGO: "algorand",      VET: "vechain",          AAVE: "aave",
  MKR: "maker",          OP: "optimism",          ARB: "arbitrum",
  INJ: "injective-protocol", HBAR: "hedera-hashgraph", GRT: "the-graph",
  SAND: "the-sandbox",   MANA: "decentraland",    AXS: "axie-infinity",
  FTM: "fantom",         CRV: "curve-dao-token",  SUSHI: "sushi",
  YFI: "yearn-finance",  SNX: "havven",           ZEC: "zcash",
  COMP: "compound-governance-token", DAI: "dai",  USDC: "usd-coin",
  TIA: "celestia",       SEI: "sei-network",      PEPE: "pepe",
  WIF: "dogwifcoin",     BONK: "bonk",            JTO: "jito-governance-token",
  JUP: "jupiter-exchange-solana", PYTH: "pyth-network",
};

// Runtime cache for unknown symbols resolved via CoinGecko search
const resolvedIds = new Map<string, string>();

/**
 * Resolve a crypto ticker (e.g. "BTC") to its CoinGecko id (e.g. "bitcoin").
 * Checks the static map, then a runtime cache, then CoinGecko search.
 * `fetchImpl` is injectable for testing. Returns null if unresolved.
 */
export async function resolveCoinGeckoId(
  ticker: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const upper = ticker.toUpperCase();
  if (COINGECKO_IDS[upper]) return COINGECKO_IDS[upper];
  if (resolvedIds.has(upper)) return resolvedIds.get(upper)!;

  try {
    const resp = await fetchImpl(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ticker)}`,
      { signal: AbortSignal.timeout(5_000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { coins?: { id: string; symbol: string }[] };
    const match = data.coins?.find(c => c.symbol.toUpperCase() === upper);
    if (match) {
      resolvedIds.set(upper, match.id);
      return match.id;
    }
  } catch { /* silently skip */ }

  return null;
}

// Backwards-compatible internal alias.
const getCoinGeckoId = resolveCoinGeckoId;

// ── Crypto: batched CoinGecko call ───────────────────────────────────────────

async function refreshCryptoBatch(
  db: Database.Database,
  tickers: string[]
): Promise<void> {
  if (tickers.length === 0) return;

  // Resolve all CoinGecko IDs (skips unknowns)
  const idMap = new Map<string, string>(); // coinGecko id → ticker
  await Promise.all(
    tickers.map(async ticker => {
      const id = await getCoinGeckoId(ticker);
      if (id) idMap.set(id, ticker.toUpperCase());
    })
  );
  if (idMap.size === 0) return;

  const ids = [...idMap.keys()].join(",");
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!resp.ok) {
      console.warn(`CoinGecko HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json() as Record<string, { usd?: number }>;
    const now = new Date().toISOString();

    const upsert = db.prepare(
      `INSERT OR REPLACE INTO price_cache (symbol, asset_type, currency, price, fetched_at)
       VALUES (?, 'crypto', 'USD', ?, ?)`
    );
    const batch = db.transaction(() => {
      for (const [cgId, prices] of Object.entries(data)) {
        const ticker = idMap.get(cgId);
        if (ticker && prices.usd != null) {
          upsert.run(ticker, prices.usd, now);
        }
      }
    });
    batch();
  } catch (err) {
    console.warn("CoinGecko batch error:", (err as Error).message);
  }
}

// ── Stock / ETF: Yahoo Finance ────────────────────────────────────────────────

async function refreshStockSingle(
  db: Database.Database,
  ticker: string,
  assetType: "stock" | "etf"
): Promise<void> {
  try {
    const quote = await yahooFinance.quote(ticker, {}, { validateResult: false }) as { regularMarketPrice?: number; currency?: string };
    const price = quote.regularMarketPrice;
    const currency = (quote.currency ?? "USD").toUpperCase();
    if (price == null) return;

    db.prepare(
      `INSERT OR REPLACE INTO price_cache (symbol, asset_type, currency, price, fetched_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(ticker.toUpperCase(), assetType, currency, price, new Date().toISOString());
  } catch (err) {
    console.warn(`Yahoo Finance error for ${ticker}:`, (err as Error).message);
  }
}

// ── Public: refresh single investment ────────────────────────────────────────

export interface PriceResult {
  symbol: string;
  price: number;
  currency: string;
  fetched_at: string;
}

export async function refreshPrice(
  db: Database.Database,
  investmentId: number
): Promise<PriceResult | null> {
  const inv = db
    .prepare<[number], { type: string; ticker: string | null }>(
      "SELECT type, ticker FROM investments WHERE id = ?"
    )
    .get(investmentId);

  if (!inv?.ticker) return null;
  const ticker = inv.ticker.toUpperCase();

  if (inv.type === "crypto") {
    await refreshCryptoBatch(db, [ticker]);
  } else if (inv.type === "stock" || inv.type === "etf") {
    await refreshStockSingle(db, ticker, inv.type as "stock" | "etf");
  } else {
    return null; // pension / education / other have no market price
  }

  const row = db
    .prepare<[string, string], PriceResult>(
      "SELECT symbol, price, currency, fetched_at FROM price_cache WHERE symbol = ? AND asset_type = ?"
    )
    .get(ticker, inv.type);
  return row ?? null;
}

// ── Public: batch refresh all positions for a user ───────────────────────────

export async function batchRefreshAll(
  db: Database.Database,
  userId: number
): Promise<{ last_sync: string; count: number }> {
  // FIX 4: Warm the FX sync cache so getRateSync() returns a live rate for the
  // portfolio computation that follows a price refresh.
  getRate(db, userId).catch(() => { /* best-effort */ });

  const investments = db
    .prepare<[number], { id: number; type: string; ticker: string | null }>(
      `SELECT id, type, ticker FROM investments
       WHERE user_id = ? AND deleted_at IS NULL AND closed_at IS NULL AND ticker IS NOT NULL`
    )
    .all(userId);

  const cryptoTickers: string[] = [];
  const stockEtfRows: { ticker: string; type: "stock" | "etf" }[] = [];

  for (const inv of investments) {
    if (!inv.ticker) continue;
    if (inv.type === "crypto") {
      cryptoTickers.push(inv.ticker);
    } else if (inv.type === "stock" || inv.type === "etf") {
      stockEtfRows.push({ ticker: inv.ticker, type: inv.type });
    }
  }

  // Crypto: one batched call
  await refreshCryptoBatch(db, cryptoTickers);

  // Stocks/ETFs: parallel (Yahoo is resilient to this)
  await Promise.allSettled(
    stockEtfRows.map(r => refreshStockSingle(db, r.ticker, r.type))
  );

  const last_sync = new Date().toISOString();
  return { last_sync, count: investments.length };
}

// ── Helpers for portfolio service (sync, reads cache only) ───────────────────

export function isCacheFresh(
  db: Database.Database,
  symbol: string,
  assetType: string
): boolean {
  const row = db
    .prepare<[string, string], { fetched_at: string }>(
      "SELECT fetched_at FROM price_cache WHERE symbol = ? AND asset_type = ?"
    )
    .get(symbol, assetType);
  if (!row) return false;
  const ttl = assetType === "crypto" ? CRYPTO_TTL_MS : STOCK_TTL_MS;
  return Date.now() - new Date(row.fetched_at).getTime() < ttl;
}
