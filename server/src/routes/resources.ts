/**
 * CRUD for the ten stored resources. Each is the factory plus whatever hook it
 * genuinely needs — e.g. creating an RSU grant expands its vesting schedule.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { ok, fail } from "../middleware/respond.js";
import { crudRouter, zodMessage } from "../api/crud.js";
import * as S from "../api/schemas.js";
import { generateVestRows, markVested } from "../calc/rsu.js";
import type { GrantRow } from "../calc/types.js";

export const accountsCrud = crudRouter({
  table: "accounts",
  createSchema: S.AccountCreate,
  updateSchema: S.AccountUpdate,
  filterable: ["category", "valuation_mode", "funding_mode", "currency", "is_active"],
  orderBy: "name COLLATE NOCASE",
});

export const holdingsCrud = crudRouter({
  table: "holdings",
  createSchema: S.HoldingCreate,
  updateSchema: S.HoldingUpdate,
  filterable: ["account_id", "asset_class"],
});

export const pricesCrud = crudRouter({
  table: "prices",
  createSchema: S.PriceCreate,
  updateSchema: S.PriceUpdate,
  filterable: ["holding_id", "date"],
  orderBy: "date DESC, id DESC",
});

export const transactionsCrud = crudRouter({
  table: "transactions",
  createSchema: S.TransactionCreate,
  updateSchema: S.TransactionUpdate,
  filterable: ["account_id", "holding_id", "type", "source", "recurring_rule_id"],
  orderBy: "date DESC, id DESC",
});

export const valuationsCrud = crudRouter({
  table: "valuations",
  createSchema: S.ValuationCreate,
  updateSchema: S.ValuationUpdate,
  filterable: ["account_id", "date"],
  orderBy: "date DESC, id DESC",
});

export const recurringRulesCrud = crudRouter({
  table: "recurring_rules",
  createSchema: S.RecurringRuleCreate,
  updateSchema: S.RecurringRuleUpdate,
  filterable: ["account_id", "is_active"],
});

export const fxRatesCrud = crudRouter({
  table: "fx_rates",
  createSchema: S.FxRateCreate,
  updateSchema: S.FxRateUpdate,
  filterable: ["date", "base_currency", "quote_currency"],
  orderBy: "date DESC, id DESC",
});

/**
 * Creating or re-shaping a grant regenerates its tranches, then immediately
 * marks any that are already due — so a grant added retroactively is correct
 * the moment it is saved.
 */
function syncGrant(db: ReturnType<typeof getDb>, id: number): void {
  const grant = db.prepare("SELECT * FROM rsu_grants WHERE id = ?").get(id) as GrantRow | undefined;
  if (!grant) return;
  generateVestRows(db, grant);
  markVested(db);
}

export const rsuGrantsCrud = crudRouter({
  table: "rsu_grants",
  createSchema: S.RsuGrantCreate,
  updateSchema: S.RsuGrantUpdate,
  filterable: ["account_id", "symbol"],
  afterCreate: syncGrant,
  afterUpdate: syncGrant,
});

export const rsuVestsCrud = crudRouter({
  table: "rsu_vests",
  createSchema: S.RsuVestCreate,
  updateSchema: S.RsuVestUpdate,
  filterable: ["grant_id", "status"],
  orderBy: "vest_date, id",
});

/** Settings are a key/value table, so they get their own tiny router. */
export const settingsRouter = Router();

settingsRouter.get("/", (_req, res) => {
  try {
    const rows = getDb().prepare("SELECT key, value FROM settings ORDER BY key").all() as
      { key: string; value: string }[];
    ok(res, Object.fromEntries(rows.map(r => [r.key, r.value])));
  } catch (e) { fail(res, (e as Error).message, 500); }
});

settingsRouter.put("/", (req, res) => {
  const parsed = S.SettingUpsert.safeParse(req.body);
  if (!parsed.success) return fail(res, zodMessage(parsed.error));
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(parsed.data.key, parsed.data.value);
    ok(res, { key: parsed.data.key, value: parsed.data.value });
  } catch (e) { fail(res, (e as Error).message, 400); }
});

settingsRouter.delete("/:key", (req, res) => {
  try {
    const r = getDb().prepare("DELETE FROM settings WHERE key = ?").run(req.params.key);
    if (r.changes === 0) return fail(res, "Setting not found", 404);
    ok(res, { key: req.params.key });
  } catch (e) { fail(res, (e as Error).message, 500); }
});
