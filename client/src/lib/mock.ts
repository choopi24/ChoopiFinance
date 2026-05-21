import type { Currency } from "@choopi/shared";

export const MOCK_USER = { name: "Choopi", email: "choopi@local" };

export const MOCK_KPIS = {
  totalValue: 487320,
  totalValueUsd: 131708,
  netInvested: 412800,
  unrealizedPct: 18.05,
  unrealizedAbs: 74520,
  realizedYtd: 12480,
  realizedYtdPct: 3.02,
};

export const MOCK_SERIES: { m: string; v: number }[] = [
  { m: "Jun '25", v: 372000 }, { m: "Jul", v: 386500 },
  { m: "Aug",    v: 401200 }, { m: "Sep", v: 395100 },
  { m: "Oct",    v: 418900 }, { m: "Nov", v: 426300 },
  { m: "Dec",    v: 433700 }, { m: "Jan '26", v: 441800 },
  { m: "Feb",    v: 454200 }, { m: "Mar", v: 462900 },
  { m: "Apr",    v: 471600 }, { m: "May", v: 487320 },
];

export const MOCK_ALLOC_TYPE = [
  { label: "Crypto",    value: 142600, color: "var(--c-crypto)" },
  { label: "Stocks",    value: 118300, color: "var(--c-stocks)" },
  { label: "ETFs",      value:  96200, color: "var(--c-etf)" },
  { label: "Pension",   value:  78400, color: "var(--c-pension)" },
  { label: "Education", value:  38900, color: "var(--c-edu)" },
  { label: "Other",     value:  12920, color: "var(--c-other)" },
];

export const MOCK_ALLOC_CCY = [
  { label: "NIS (₪)", value: 312400, color: "#7C3AED" },
  { label: "USD ($)", value: 174920, color: "#F472B6" },
];

export const MOCK_ACTIVITY = [
  { id: 1, kind: "BUY"  as const, asset: "BTC",          sub: "Ledger wallet · 0.0125 BTC",       val: 8420,  ccy: "NIS" as Currency, when: "2h ago" },
  { id: 2, kind: "DIV"  as const, asset: "VOO",          sub: "Vanguard S&P 500 dividend",         val: 312,   ccy: "USD" as Currency, when: "yesterday" },
  { id: 3, kind: "SELL" as const, asset: "NVDA",         sub: "4 shares · Realized +₪3,180",       val: 6240,  ccy: "USD" as Currency, when: "2 days ago" },
  { id: 4, kind: "BUY"  as const, asset: "IWDA.AS",      sub: "Accumulating ETF · 12 shares",      val: 1080,  ccy: "USD" as Currency, when: "3 days ago" },
  { id: 5, kind: "UPD"  as const, asset: "Menora Pension", sub: "Balance updated manually",        val: 78400, ccy: "NIS" as Currency, when: "5 days ago" },
];

export const MOCK_REALIZED_YEARS = [
  { year: 2026, total:  12480, count: 18, dividends: 1245, capital: 11235 },
  { year: 2025, total:  28940, count: 47, dividends: 4120, capital: 24820 },
  { year: 2024, total:   9650, count: 22, dividends: 2880, capital:  6770 },
  { year: 2023, total:  -3120, count: 14, dividends: 1620, capital: -4740 },
];

export const MOCK_INVESTMENTS = [
  { id: "i1",  type: "crypto"  as const, name: "Bitcoin",            ticker: "BTC",     sub: "Ledger Hardware Wallet",          units: 0.412, avgPrice: 39200, price: 68450, value: 28201, ccy: "USD" as Currency, change24: 2.4 },
  { id: "i2",  type: "crypto"  as const, name: "Ethereum",           ticker: "ETH",     sub: "MetaMask",                        units: 3.18,  avgPrice: 2200,  price: 3580,  value: 11384, ccy: "USD" as Currency, change24: -1.2 },
  { id: "i3",  type: "stock"     as const, name: "NVIDIA Corp",        ticker: "NVDA",    sub: "IBKR · 18 shares",                units: 18,    avgPrice: 280,   price: 925,   value: 16650, ccy: "USD" as Currency, change24: 1.1 },
  { id: "i4",  type: "etf"       as const, name: "iShares MSCI World", ticker: "IWDA.AS", sub: "Accum · ISIN IE00B4L5Y983",       units: 185,   avgPrice: 78,    price: 96,    value: 17760, ccy: "USD" as Currency, change24: 0.4 },
  { id: "i5",  type: "pension"   as const, name: "Menora Pension",     ticker: "—",       sub: "Updated 47 days ago",              units: 1,     avgPrice: 78400, price: 78400, value: 78400, ccy: "NIS" as Currency, change24: 0, stale: true },
  { id: "i6",  type: "education" as const, name: "Education Fund",     ticker: "—",       sub: "Liquidates in 4y 10mo · Mar 2031", units: 1,     avgPrice: 38900, price: 38900, value: 38900, ccy: "NIS" as Currency, change24: 0 },
  { id: "i7",  type: "other"   as const, name: "Wine collection",    ticker: "—",       sub: "Manual valuation",                 units: 1,     avgPrice: 11000, price: 12920, value: 12920, ccy: "NIS" as Currency, change24: 0 },
];

export const MOCK_TRANSACTIONS = [
  { id: "t1", date: "2026-05-16", time: "14:22", kind: "BUY"  as const, asset: "BTC",     qty: "0.0125", price: "$67,360", total: "$842",    ccy: "USD" as Currency, fee: "$4.20",  note: "Ledger" },
  { id: "t2", date: "2026-05-15", time: "09:30", kind: "DIV"  as const, asset: "VOO",     qty: "—",      price: "—",       total: "+$312",   ccy: "USD" as Currency, fee: "—",      note: "Quarterly" },
  { id: "t3", date: "2026-05-14", time: "16:01", kind: "SELL" as const, asset: "NVDA",    qty: "4",      price: "$925",    total: "+$3,700", ccy: "USD" as Currency, fee: "$1.50",  note: "Realized +$880" },
  { id: "t4", date: "2026-05-13", time: "11:48", kind: "BUY"  as const, asset: "IWDA.AS", qty: "12",     price: "$96",     total: "$1,152",  ccy: "USD" as Currency, fee: "$0.95",  note: "DCA" },
  { id: "t5", date: "2026-05-11", time: "08:15", kind: "UPD"  as const, asset: "Menora",  qty: "—",      price: "—",       total: "₪78,400", ccy: "NIS" as Currency, fee: "—",      note: "Manual update" },
];
