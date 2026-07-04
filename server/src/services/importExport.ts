/**
 * JSON export/import of a user's full ledger.
 *
 * Export (schema_version 2) covers: investments, transactions, portfolio
 * snapshots, RSU grants + vesting events. schema_version 1 payloads (pre-RSU
 * exports) import fine — the RSU arrays are just absent.
 *
 * Import replaces the user's rows inside ONE transaction, remapping every id
 * (investments → transactions → rsu_grants → rsu_vesting_events) so a payload
 * restores cleanly regardless of what ids the live DB has handed out since
 * the export was taken. Callers should runBackup() first — the settings route
 * does.
 */

import type Database from "better-sqlite3";

export const EXPORT_SCHEMA_VERSION = 2;

interface Row { [k: string]: unknown }

export interface ExportPayload {
  exported_at: string;
  schema_version: number;
  user: Row | undefined;
  investments: Row[];
  transactions: Row[];
  snapshots: Row[];
  rsu_grants?: Row[];
  rsu_vesting_events?: Row[];
}

// ── Export ────────────────────────────────────────────────────────────────────

export function buildExport(db: Database.Database, userId: number): ExportPayload {
  const user = db
    .prepare("SELECT id, username, display_name, display_currency, theme, created_at FROM users WHERE id = ?")
    .get(userId) as Row | undefined;

  return {
    exported_at: new Date().toISOString(),
    schema_version: EXPORT_SCHEMA_VERSION,
    user,
    investments: db.prepare("SELECT * FROM investments WHERE user_id = ? ORDER BY created_at").all(userId) as Row[],
    transactions: db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY occurred_at").all(userId) as Row[],
    snapshots: db.prepare("SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY snapshot_at").all(userId) as Row[],
    rsu_grants: db.prepare("SELECT * FROM rsu_grants WHERE user_id = ? ORDER BY id").all(userId) as Row[],
    rsu_vesting_events: db.prepare(
      `SELECT e.* FROM rsu_vesting_events e
       JOIN rsu_grants g ON g.id = e.grant_id
       WHERE g.user_id = ? ORDER BY e.id`
    ).all(userId) as Row[],
  };
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportCounts {
  investments: number;
  transactions: number;
  snapshots: number;
  rsu_grants: number;
  rsu_vesting_events: number;
}

/** Structural validation — returns an error string or null when acceptable. */
export function validateImportPayload(raw: unknown): string | null {
  const p = raw as Partial<ExportPayload> | null;
  if (!p || typeof p !== "object") return "Body must be a JSON export payload";
  if (p.schema_version !== 1 && p.schema_version !== EXPORT_SCHEMA_VERSION) {
    return `Unsupported schema_version ${p.schema_version} — expected 1 or ${EXPORT_SCHEMA_VERSION}`;
  }
  for (const key of ["investments", "transactions", "snapshots"] as const) {
    if (!Array.isArray(p[key])) return `${key} must be an array`;
  }
  if (p.rsu_grants != null && !Array.isArray(p.rsu_grants)) return "rsu_grants must be an array";
  if (p.rsu_vesting_events != null && !Array.isArray(p.rsu_vesting_events)) return "rsu_vesting_events must be an array";
  return null;
}

const num = (v: unknown): number | null => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Replace the user's ledger with the payload's rows (single transaction).
 * All ids are remapped; rows belonging to other users are untouched.
 */
export function importUserData(
  db: Database.Database,
  userId: number,
  payload: ExportPayload
): ImportCounts {
  const counts: ImportCounts = {
    investments: 0, transactions: 0, snapshots: 0, rsu_grants: 0, rsu_vesting_events: 0,
  };

  const run = db.transaction(() => {
    // Wipe (children first — rsu events cascade with grants)
    db.prepare("DELETE FROM rsu_grants WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM transactions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM investments WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM portfolio_snapshots WHERE user_id = ?").run(userId);

    // Investments (id remap root)
    const invMap = new Map<number, number>();
    const insInv = db.prepare(
      `INSERT INTO investments
         (user_id, type, name, ticker, isin, broker, etf_kind, liquid_date, closed_at, deleted_at,
          monthly_deposit, deposit_currency, expected_annual_return, monthly_contribution,
          fund_id, fund_track, fee_deposit_pct, fee_balance_pct, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of payload.investments) {
      const res = insInv.run(
        userId, str(r.type), str(r.name), str(r.ticker), str(r.isin), str(r.broker),
        str(r.etf_kind), str(r.liquid_date), str(r.closed_at), str(r.deleted_at),
        num(r.monthly_deposit), str(r.deposit_currency) ?? "NIS",
        num(r.expected_annual_return), num(r.monthly_contribution),
        num(r.fund_id), str(r.fund_track), num(r.fee_deposit_pct), num(r.fee_balance_pct),
        str(r.created_at) ?? new Date().toISOString()
      );
      invMap.set(Number(r.id), res.lastInsertRowid as number);
      counts.investments++;
    }

    // Transactions (needs invMap; builds txMap for RSU events)
    const txMap = new Map<number, number>();
    const insTx = db.prepare(
      `INSERT INTO transactions
         (investment_id, user_id, kind, units, price_per_unit, total_amount, currency,
          occurred_at, notes, realized_pl, fx_rate_at_buy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of payload.transactions) {
      const invId = invMap.get(Number(r.investment_id));
      if (invId == null) throw new Error(`transaction ${r.id} references unknown investment ${r.investment_id}`);
      const res = insTx.run(
        invId, userId, str(r.kind), num(r.units), num(r.price_per_unit),
        num(r.total_amount) ?? 0, str(r.currency) ?? "NIS",
        str(r.occurred_at), str(r.notes), num(r.realized_pl), num(r.fx_rate_at_buy),
        str(r.created_at) ?? new Date().toISOString()
      );
      txMap.set(Number(r.id), res.lastInsertRowid as number);
      counts.transactions++;
    }

    // Snapshots (no FKs beyond user)
    const insSnap = db.prepare(
      `INSERT INTO portfolio_snapshots
         (user_id, total_value_nis, total_value_usd, total_net_deposited_nis, total_net_deposited_usd, snapshot_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of payload.snapshots) {
      insSnap.run(
        userId, num(r.total_value_nis) ?? 0, num(r.total_value_usd) ?? 0,
        num(r.total_net_deposited_nis) ?? 0, num(r.total_net_deposited_usd) ?? 0,
        str(r.snapshot_at) ?? new Date().toISOString()
      );
      counts.snapshots++;
    }

    // RSU grants + events (v2 payloads)
    const grantMap = new Map<number, number>();
    const insGrant = db.prepare(
      `INSERT INTO rsu_grants
         (investment_id, user_id, symbol, company_name, grant_date, total_units,
          grant_price, currency, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of payload.rsu_grants ?? []) {
      const invId = invMap.get(Number(r.investment_id));
      if (invId == null) throw new Error(`rsu_grant ${r.id} references unknown investment ${r.investment_id}`);
      const res = insGrant.run(
        invId, userId, str(r.symbol), str(r.company_name), str(r.grant_date),
        num(r.total_units) ?? 0, num(r.grant_price), str(r.currency) ?? "USD", str(r.notes),
        str(r.created_at) ?? new Date().toISOString(),
        str(r.updated_at) ?? new Date().toISOString()
      );
      grantMap.set(Number(r.id), res.lastInsertRowid as number);
      counts.rsu_grants++;
    }

    const insEvent = db.prepare(
      `INSERT INTO rsu_vesting_events
         (grant_id, vest_date, units, fmv_at_vest, status, transaction_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of payload.rsu_vesting_events ?? []) {
      const grantId = grantMap.get(Number(r.grant_id));
      if (grantId == null) throw new Error(`rsu event ${r.id} references unknown grant ${r.grant_id}`);
      const txId = r.transaction_id != null ? (txMap.get(Number(r.transaction_id)) ?? null) : null;
      insEvent.run(
        grantId, str(r.vest_date), num(r.units) ?? 0, num(r.fmv_at_vest),
        str(r.status) ?? "scheduled", txId,
        str(r.created_at) ?? new Date().toISOString()
      );
      counts.rsu_vesting_events++;
    }
  });
  run();

  return counts;
}
