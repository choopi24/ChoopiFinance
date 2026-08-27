/**
 * The only place calc talks to SQLite. Loads the whole ledger (or one account's
 * slice) in a fixed number of queries so the engine can answer any number of
 * dates without touching the DB again.
 *
 * Rows come back sorted by date ascending — the engine's carry-forward scans
 * rely on that ordering.
 */

import type Database from "better-sqlite3";
import type { IsoDate } from "./dates.js";
import type {
  AccountRow, FxRow, GrantRow, HoldingRow, Ledger, PriceRow, TxRow, ValuationRow, VestRow,
} from "./types.js";

export function loadLedger(db: Database.Database, opts: { includeInactive?: boolean } = {}): Ledger {
  const where = opts.includeInactive ? "" : "WHERE is_active = 1";
  return {
    accounts: db.prepare(`SELECT * FROM accounts ${where} ORDER BY id`).all() as AccountRow[],
    holdings: db.prepare("SELECT * FROM holdings ORDER BY id").all() as HoldingRow[],
    prices: db.prepare("SELECT holding_id, date, price_minor, currency FROM prices ORDER BY date").all() as PriceRow[],
    transactions: db.prepare("SELECT * FROM transactions ORDER BY date, id").all() as TxRow[],
    valuations: db.prepare("SELECT account_id, date, balance_minor, currency FROM valuations ORDER BY date").all() as ValuationRow[],
    fx: db.prepare("SELECT date, base_currency, quote_currency, rate FROM fx_rates ORDER BY date").all() as FxRow[],
    grants: db.prepare("SELECT * FROM rsu_grants ORDER BY id").all() as GrantRow[],
    vests: db.prepare("SELECT * FROM rsu_vests ORDER BY vest_date, id").all() as VestRow[],
  };
}

export function getAccount(db: Database.Database, id: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

export function displayCurrency(db: Database.Database): "ILS" | "USD" {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'display_currency'")
    .get() as { value: string } | undefined;
  return row?.value === "USD" ? "USD" : "ILS";
}

/** A setting read as a boolean ('true'/'1' are true). */
export function boolSetting(db: Database.Database, key: string, fallback = false): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  return row.value === "true" || row.value === "1";
}

export function numSetting(db: Database.Database, key: string, fallback: number): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Accounts whose newest price or balance is older than `days`. */
export function staleAccounts(db: Database.Database, days: number, asOf: IsoDate) {
  return db.prepare(`
    SELECT a.id, a.name, a.category, a.valuation_mode,
           CASE a.valuation_mode
             WHEN 'balance' THEN (SELECT MAX(v.date) FROM valuations v WHERE v.account_id = a.id)
             ELSE (SELECT MAX(p.date) FROM prices p
                   JOIN holdings h ON h.id = p.holding_id WHERE h.account_id = a.id)
           END AS last_data_date
    FROM accounts a
    WHERE a.is_active = 1
  `).all().filter((r) => {
    const row = r as { last_data_date: string | null };
    if (!row.last_data_date) return true;
    return (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${row.last_data_date}T00:00:00Z`))
      / 86_400_000 > days;
  }) as { id: number; name: string; category: string; valuation_mode: string; last_data_date: string | null }[];
}
