/**
 * Money in, money out.
 *
 * Everything crossing the wire is INTEGER minor units (agorot / cents) — see
 * the schema header. This module is the only place that converts to and from
 * the decimal strings a person types and reads, so a rounding rule can never
 * disagree with itself in two screens.
 */

export const SYMBOL = { ILS: "₪", USD: "$" };

export const symbolOf = (currency) => SYMBOL[currency] ?? "";

/**
 * Format minor units. Large sums drop the decimals — on a 390px screen the
 * agorot in ₪1,086,775.53 cost two digits of headline size and tell you nothing.
 */
export function money(minor, currency = "ILS", { decimals = "auto", sign = false } = {}) {
  if (minor == null || Number.isNaN(minor)) return "—";
  const major = minor / 100;
  const showDecimals = decimals === "auto" ? Math.abs(major) < 1000 : decimals;

  const body = Math.abs(major).toLocaleString("en-US", {
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  });

  const prefix = minor < 0 ? "-" : sign && minor > 0 ? "+" : "";
  return `${prefix}${symbolOf(currency)}${body}`;
}

/** Axis and chip labels: ₪1.09M, ₪250K, ₪940. */
export function moneyCompact(minor, currency = "ILS") {
  if (minor == null || Number.isNaN(minor)) return "—";
  const major = minor / 100;
  const abs = Math.abs(major);
  const sign = major < 0 ? "-" : "";
  const sym = symbolOf(currency);

  if (abs >= 1e6) return `${sign}${sym}${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${sym}${trim(abs / 1e3)}K`;
  return `${sign}${sym}${Math.round(abs).toLocaleString("en-US")}`;
}

/** 1.2 → "1.2", 1.0 → "1" — a trailing ".0" is noise on an axis. */
function trim(n) {
  const s = n.toFixed(n < 10 ? 2 : 1);
  return s.replace(/\.?0+$/, "");
}

export function pct(value, { decimals = 1, sign = true } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  const prefix = sign && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(decimals)}%`;
}

export function units(n, { max = 4 } = {}) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

/**
 * "1,234.5" → 123450. Returns null for anything that isn't a number, so the
 * caller decides what an empty field means.
 */
export function parseMoney(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/[,\s₪$]/g, "").trim();
  if (!cleaned || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function parseNumber(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/[,\s]/g, "").trim();
  if (!cleaned || !/^-?\d*\.?\d*$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Minor units back into an editable decimal string, with no thousands commas. */
export const toInputValue = (minor) => (minor == null ? "" : (minor / 100).toFixed(2));

// ── dates ────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const todayIso = () => {
  // Built from the local clock, not toISOString(), so a late-evening entry in
  // Israel isn't filed under tomorrow (or yesterday) by a UTC offset.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function shiftDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last day of the previous month — how balance statements are dated. */
export function lastMonthEnd(iso = todayIso()) {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(y, m - 1, 0); // day 0 of this month = last day of previous
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dateLabel(iso, { year = "auto" } = {}) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  const showYear = year === "auto" ? y !== new Date().getFullYear() : year;
  return `${d} ${MONTHS[m - 1]}${showYear ? ` ${y}` : ""}`;
}

export const monthLabel = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
};

export function daysAgo(iso, from = todayIso()) {
  if (!iso) return null;
  return Math.round((Date.parse(from) - Date.parse(iso)) / 86400000);
}

export function agoLabel(iso) {
  const d = daysAgo(iso);
  if (d == null) return "never";
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
}
