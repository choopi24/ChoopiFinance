/**
 * The JSON representation of the whole ledger.
 *
 * Shared by the export endpoint and the backup job, so the file you download
 * from Settings and the file sitting next to a nightly .db snapshot are byte
 * for byte the same format — and both import through the same code path.
 *
 * This is the format that survives SQLite itself: a .db file needs a compatible
 * SQLite to open, a JSON file needs a text editor.
 */

import type Database from "better-sqlite3";

/** Parents before children, so a restore can insert in order with FKs on. */
export const LEDGER_TABLES = [
  "accounts", "holdings", "prices", "recurring_rules", "transactions",
  "valuations", "fx_rates", "rsu_grants", "rsu_vests",
] as const;

export const EXPORT_FORMAT = "choopi-ledger";
export const EXPORT_SCHEMA_VERSION = 3;

export interface ExportPayload {
  format: string;
  schema_version: number;
  exported_at: string;
  settings: Record<string, string>;
  tables: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
}

export function readSettings(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings").all() as
    { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export function buildExport(db: Database.Database): ExportPayload {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};

  for (const table of LEDGER_TABLES) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    tables[table] = rows;
    counts[table] = rows.length;
  }

  return {
    format: EXPORT_FORMAT,
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    settings: readSettings(db),
    tables,
    counts,
  };
}

export function validateExport(payload: unknown): asserts payload is ExportPayload {
  const p = payload as ExportPayload | null;
  if (!p || typeof p !== "object") throw new Error("Not a Choopi ledger export");
  if (p.format !== EXPORT_FORMAT) throw new Error("Not a Choopi ledger export");
  if (!p.tables || typeof p.tables !== "object") throw new Error("Export has no tables");
}

export interface ImportResult { counts: Record<string, number> }

/**
 * Replace the ledger with the contents of an export.
 *
 * Original ids are preserved, so every foreign key inside the payload stays
 * valid with no remapping pass. Foreign keys are switched off for the swap and
 * back on afterwards — the whole thing is one transaction, so a failure part
 * way leaves the previous ledger exactly as it was.
 */
export function importExport(db: Database.Database, payload: ExportPayload): ImportResult {
  validateExport(payload);
  const counts: Record<string, number> = {};

  db.transaction(() => {
    db.pragma("foreign_keys = OFF");
    for (const table of [...LEDGER_TABLES].reverse()) db.prepare(`DELETE FROM ${table}`).run();

    for (const table of LEDGER_TABLES) {
      const rows = payload.tables[table] ?? [];
      counts[table] = rows.length;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(c => `@${c}`).join(", ")})`
      );
      for (const row of rows) stmt.run(row);
    }

    if (payload.settings) {
      const write = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      );
      for (const [k, v] of Object.entries(payload.settings)) write.run(k, String(v));
    }
    db.pragma("foreign_keys = ON");
  })();

  return { counts };
}

/**
 * A small, comparable fingerprint of the ledger: row counts plus the signed sum
 * of every money column. Restoring a backup and getting the same fingerprint is
 * what "the numbers match" actually means.
 */
export function fingerprint(db: Database.Database): Record<string, number> {
  const one = (sql: string): number => {
    const row = db.prepare(sql).get() as { v: number | null };
    return Math.round(row?.v ?? 0);
  };

  return {
    accounts: one("SELECT COUNT(*) v FROM accounts"),
    holdings: one("SELECT COUNT(*) v FROM holdings"),
    transactions: one("SELECT COUNT(*) v FROM transactions"),
    prices: one("SELECT COUNT(*) v FROM prices"),
    valuations: one("SELECT COUNT(*) v FROM valuations"),
    fx_rates: one("SELECT COUNT(*) v FROM fx_rates"),
    rsu_grants: one("SELECT COUNT(*) v FROM rsu_grants"),
    rsu_vests: one("SELECT COUNT(*) v FROM rsu_vests"),
    recurring_rules: one("SELECT COUNT(*) v FROM recurring_rules"),
    sum_transactions_minor: one("SELECT COALESCE(SUM(amount_minor),0) v FROM transactions"),
    sum_deposits_minor: one("SELECT COALESCE(SUM(amount_minor),0) v FROM transactions WHERE type='deposit'"),
    sum_fees_minor: one("SELECT COALESCE(SUM(amount_minor),0) v FROM transactions WHERE type='fee'"),
    sum_valuations_minor: one("SELECT COALESCE(SUM(balance_minor),0) v FROM valuations"),
    sum_prices_minor: one("SELECT COALESCE(SUM(price_minor),0) v FROM prices"),
  };
}
