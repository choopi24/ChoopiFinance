/**
 * JSON export/import of a user's whole ledger — schema v3 (the manual-entry model).
 *
 * Everything you hand-entered is in here: accounts, ledger entries, the price
 * and FX series, deposit rules, RSU grants and vesting events. Since no external
 * source can rebuild any of it, this file IS your data.
 *
 * Import replaces the user's rows inside ONE transaction, remapping every id so a
 * payload restores cleanly whatever ids the live DB has since handed out. Callers
 * should runBackup() first — the settings route does.
 */

import type Database from "better-sqlite3";

export const EXPORT_SCHEMA_VERSION = 3;

interface Row { [k: string]: unknown }

export interface ExportPayload {
  exported_at: string;
  schema_version: number;
  user: Row | undefined;
  accounts: Row[];
  entries: Row[];
  price_points: Row[];
  fx_rates: Row[];
  deposit_rules: Row[];
  rsu_grants: Row[];
  rsu_vesting_events: Row[];
  snapshots?: Row[];
}

// ── Export ────────────────────────────────────────────────────────────────────

export function buildExport(db: Database.Database, userId: number): ExportPayload {
  const all = (sql: string) => db.prepare(sql).all(userId) as Row[];

  return {
    exported_at: new Date().toISOString(),
    schema_version: EXPORT_SCHEMA_VERSION,
    user: db.prepare(
      "SELECT id, username, display_name, display_currency, theme, created_at FROM users WHERE id = ?"
    ).get(userId) as Row | undefined,
    accounts: all("SELECT * FROM accounts WHERE user_id = ? ORDER BY id"),
    entries: all("SELECT * FROM entries WHERE user_id = ? ORDER BY occurred_on, id"),
    price_points: all("SELECT * FROM price_points WHERE user_id = ? ORDER BY symbol, as_of"),
    fx_rates: all("SELECT * FROM fx_rates WHERE user_id = ? ORDER BY as_of"),
    deposit_rules: all("SELECT * FROM deposit_rules WHERE user_id = ? ORDER BY id"),
    rsu_grants: all("SELECT * FROM rsu_grants WHERE user_id = ? ORDER BY id"),
    rsu_vesting_events: db.prepare(
      `SELECT e.* FROM rsu_vesting_events e JOIN rsu_grants g ON g.id = e.grant_id
       WHERE g.user_id = ? ORDER BY e.id`
    ).all(userId) as Row[],
    snapshots: all("SELECT * FROM portfolio_snapshots WHERE user_id = ? ORDER BY snapshot_on"),
  };
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportCounts {
  accounts: number;
  entries: number;
  price_points: number;
  fx_rates: number;
  deposit_rules: number;
  rsu_grants: number;
  rsu_vesting_events: number;
}

export function validateImportPayload(raw: unknown): string | null {
  const p = raw as Partial<ExportPayload> | null;
  if (!p || typeof p !== "object") return "Body must be a JSON export payload";
  if (p.schema_version !== EXPORT_SCHEMA_VERSION) {
    return `This file is schema_version ${p.schema_version}; this app imports version ${EXPORT_SCHEMA_VERSION}`;
  }
  for (const key of ["accounts", "entries", "price_points", "fx_rates"] as const) {
    if (!Array.isArray(p[key])) return `${key} must be an array`;
  }
  return null;
}

const num = (v: unknown): number | null => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));

export function importUserData(
  db: Database.Database,
  userId: number,
  payload: ExportPayload
): ImportCounts {
  const counts: ImportCounts = {
    accounts: 0, entries: 0, price_points: 0, fx_rates: 0,
    deposit_rules: 0, rsu_grants: 0, rsu_vesting_events: 0,
  };

  const run = db.transaction(() => {
    // Wipe (children cascade from accounts; the rest are user-scoped).
    db.prepare("DELETE FROM rsu_grants WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM deposit_rules WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM entries WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM accounts WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM price_points WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM fx_rates WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM portfolio_snapshots WHERE user_id = ?").run(userId);

    // Accounts (id remap root)
    const accountMap = new Map<number, number>();
    const insAccount = db.prepare(
      `INSERT INTO accounts (user_id, name, kind, valuation_mode, funding_mode, currency,
                             symbol, fee_deposit_pct, fee_balance_annual_pct, notes,
                             closed_at, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of payload.accounts) {
      const id = insAccount.run(
        userId, str(a.name), str(a.kind), str(a.valuation_mode), str(a.funding_mode) ?? "manual",
        str(a.currency) ?? "ILS", str(a.symbol), num(a.fee_deposit_pct), num(a.fee_balance_annual_pct),
        str(a.notes), str(a.closed_at), str(a.archived_at),
        str(a.created_at) ?? new Date().toISOString(), str(a.updated_at) ?? new Date().toISOString()
      ).lastInsertRowid as number;
      accountMap.set(Number(a.id), id);
      counts.accounts++;
    }

    // Deposit rules before entries, so rule_id can be remapped.
    const ruleMap = new Map<number, number>();
    const insRule = db.prepare(
      `INSERT INTO deposit_rules (account_id, user_id, amount, currency, day_of_month,
                                  start_on, end_on, active, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of payload.deposit_rules ?? []) {
      const accountId = accountMap.get(Number(r.account_id));
      if (accountId == null) throw new Error(`deposit_rule ${r.id} points at unknown account ${r.account_id}`);
      const id = insRule.run(
        accountId, userId, num(r.amount) ?? 0, str(r.currency) ?? "ILS",
        num(r.day_of_month) ?? 1, str(r.start_on), str(r.end_on),
        r.active ? 1 : 0, str(r.note),
        str(r.created_at) ?? new Date().toISOString(), str(r.updated_at) ?? new Date().toISOString()
      ).lastInsertRowid as number;
      ruleMap.set(Number(r.id), id);
      counts.deposit_rules++;
    }

    // Entries
    const entryMap = new Map<number, number>();
    const insEntry = db.prepare(
      `INSERT INTO entries (account_id, user_id, kind, occurred_on, amount, quantity,
                            price_per_unit, source, rule_id, fee_kind, is_estimate,
                            period_start, period_end, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of payload.entries) {
      const accountId = accountMap.get(Number(e.account_id));
      if (accountId == null) throw new Error(`entry ${e.id} points at unknown account ${e.account_id}`);
      const id = insEntry.run(
        accountId, userId, str(e.kind), str(e.occurred_on), num(e.amount), num(e.quantity),
        num(e.price_per_unit), str(e.source) ?? "manual",
        e.rule_id != null ? (ruleMap.get(Number(e.rule_id)) ?? null) : null,
        str(e.fee_kind), e.is_estimate ? 1 : 0,
        str(e.period_start), str(e.period_end), str(e.note),
        str(e.created_at) ?? new Date().toISOString()
      ).lastInsertRowid as number;
      entryMap.set(Number(e.id), id);
      counts.entries++;
    }

    // Price + FX series
    const insPrice = db.prepare(
      `INSERT INTO price_points (user_id, symbol, price, currency, as_of, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of payload.price_points) {
      insPrice.run(userId, str(p.symbol), num(p.price) ?? 0, str(p.currency) ?? "ILS",
                   str(p.as_of), str(p.note), str(p.created_at) ?? new Date().toISOString());
      counts.price_points++;
    }
    const insFx = db.prepare(
      `INSERT INTO fx_rates (user_id, base, quote, rate, as_of, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of payload.fx_rates) {
      insFx.run(userId, str(f.base), str(f.quote), num(f.rate) ?? 1, str(f.as_of),
                str(f.note), str(f.created_at) ?? new Date().toISOString());
      counts.fx_rates++;
    }

    // RSU grants + events
    const grantMap = new Map<number, number>();
    const insGrant = db.prepare(
      `INSERT INTO rsu_grants (account_id, user_id, grant_date, total_units, grant_price,
                               notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const g of payload.rsu_grants ?? []) {
      const accountId = accountMap.get(Number(g.account_id));
      if (accountId == null) throw new Error(`rsu_grant ${g.id} points at unknown account ${g.account_id}`);
      const id = insGrant.run(
        accountId, userId, str(g.grant_date), num(g.total_units) ?? 0, num(g.grant_price),
        str(g.notes), str(g.created_at) ?? new Date().toISOString(),
        str(g.updated_at) ?? new Date().toISOString()
      ).lastInsertRowid as number;
      grantMap.set(Number(g.id), id);
      counts.rsu_grants++;
    }
    const insEvent = db.prepare(
      `INSERT INTO rsu_vesting_events (grant_id, vest_on, units, fmv_at_vest, status, entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const v of payload.rsu_vesting_events ?? []) {
      const grantId = grantMap.get(Number(v.grant_id));
      if (grantId == null) throw new Error(`rsu event ${v.id} points at unknown grant ${v.grant_id}`);
      insEvent.run(
        grantId, str(v.vest_on), num(v.units) ?? 0, num(v.fmv_at_vest),
        str(v.status) ?? "scheduled",
        v.entry_id != null ? (entryMap.get(Number(v.entry_id)) ?? null) : null,
        str(v.created_at) ?? new Date().toISOString()
      );
      counts.rsu_vesting_events++;
    }

    // Snapshots (audit trail; safe to restore as-is)
    const insSnap = db.prepare(
      `INSERT INTO portfolio_snapshots (user_id, currency, value, principal, gross_earnings, fees, snapshot_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of payload.snapshots ?? []) {
      insSnap.run(userId, str(s.currency) ?? "ILS", num(s.value) ?? 0, num(s.principal) ?? 0,
                  num(s.gross_earnings) ?? 0, num(s.fees) ?? 0, str(s.snapshot_on));
    }
  });
  run();

  return counts;
}
