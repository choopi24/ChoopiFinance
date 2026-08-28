/**
 * Names and colours for the modelled categories.
 *
 * The Israeli long-term-savings products are labelled bilingually. They have no
 * settled English names — everybody says "keren hishtalmut", nobody says
 * "study fund" — so the Hebrew is what makes the row identifiable at a glance,
 * and the English is what makes it sortable and searchable. Everything else in
 * the UI stays English.
 */

export const CATEGORY = {
  stock:            { en: "Stocks",                 he: null,                    short: "Stock",    color: "--c-stocks" },
  etf:              { en: "ETFs",                   he: null,                    short: "ETF",      color: "--c-etf" },
  crypto:           { en: "Crypto",                 he: null,                    short: "Crypto",   color: "--c-crypto" },
  rsu:              { en: "RSUs",                   he: null,                    short: "RSU",      color: "--c-rsu" },
  cash:             { en: "Cash",                   he: null,                    short: "Cash",     color: "--c-mm" },
  keren_hishtalmut: { en: "Keren Hishtalmut",       he: "קרן השתלמות",           short: "Hishtalmut", color: "--c-edu" },
  pension:          { en: "Pension",                he: "פנסיה",                 short: "Pension",  color: "--c-pension" },
  gemel_lehashkaa:  { en: "Kupat Gemel Lehashkaa",  he: "קופת גמל להשקעה",       short: "Gemel",    color: "--c-gemel" },
};

/** Buckets used by the allocation donut when grouped by asset class. */
export const ASSET_CLASS = {
  stock:   { en: "Stocks",             he: null, color: "--c-stocks" },
  etf:     { en: "ETFs",               he: null, color: "--c-etf" },
  crypto:  { en: "Crypto",             he: null, color: "--c-crypto" },
  rsu:     { en: "RSUs",               he: null, color: "--c-rsu" },
  cash:    { en: "Cash",               he: null, color: "--c-mm" },
  savings: { en: "Long-term savings",  he: null, color: "--c-pension" },
};

/** "Keren Hishtalmut (קרן השתלמות)" — the form used in pickers and headings. */
export function categoryFull(key) {
  const c = CATEGORY[key];
  if (!c) return key;
  return c.he ? `${c.en} (${c.he})` : c.en;
}

export const categoryEn = (key) => CATEGORY[key]?.en ?? key;
export const categoryHe = (key) => CATEGORY[key]?.he ?? null;
export const categoryShort = (key) => CATEGORY[key]?.short ?? key;

export function labelFor(key, by = "category") {
  const src = by === "asset_class" ? ASSET_CLASS : CATEGORY;
  const entry = src[key];
  if (!entry) return key;
  return entry.he ? `${entry.en} (${entry.he})` : entry.en;
}

export function colorVarFor(key, by = "category") {
  const src = by === "asset_class" ? ASSET_CLASS : CATEGORY;
  return src[key]?.color ?? "--c-other";
}

export const VALUATION_MODE = {
  market:  { label: "Market-priced", hint: "Value = units × the latest price you entered" },
  balance: { label: "Balance-tracked", hint: "Value = the latest balance you entered" },
};

export const FUNDING_MODE = {
  manual:  { label: "Manual", hint: "You add deposits when you make them" },
  salary:  { label: "Salary-funded", hint: "Deposits post automatically from a recurring rule" },
  passive: { label: "Passive", hint: "No deposits — the value just moves on its own" },
};

export const TX_TYPE = {
  deposit:    { label: "Deposit",    direction: "in",  color: "--emerald" },
  withdrawal: { label: "Withdrawal", direction: "out", color: "--rose" },
  buy:        { label: "Buy",        direction: "out", color: "--rose" },
  sell:       { label: "Sell",       direction: "in",  color: "--emerald" },
  dividend:   { label: "Dividend",   direction: "in",  color: "--emerald" },
  fee:        { label: "Fee",        direction: "out", color: "--amber" },
  adjustment: { label: "Adjustment", direction: "either", color: "--c-other" },
};

export const FEE_KIND = {
  management_balance: "Management — on balance (דמי ניהול מצבירה)",
  management_deposit: "Management — on deposit (דמי ניהול מהפקדה)",
  trade: "Trading commission",
  other: "Other",
};

export const FEE_KIND_SHORT = {
  management_balance: "On balance",
  management_deposit: "On deposit",
  trade: "Trading",
  other: "Other",
};

export const CONTRIBUTION_PART = {
  employee: "Employee (עובד)",
  employer: "Employer (מעסיק)",
  severance: "Severance (פיצויים)",
};

export const FREQUENCY = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" };

/** Read a CSS custom property off the root — charts need real colour values. */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
