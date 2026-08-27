/**
 * CSV import/export, per table, for bulk manual entry — the fastest way to get
 * a year of statements in, and the escape hatch that keeps the data yours.
 *
 * Import is all-or-nothing: every row is validated with the same zod schema the
 * REST endpoint uses, and only if ALL rows pass does anything get written. A
 * half-imported file is worse than a rejected one.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { ok, fail } from "../middleware/respond.js";
import { zodMessage } from "../api/crud.js";
import * as S from "../api/schemas.js";
import type { ZodType } from "zod";

export const csvRouter = Router();

/** Which tables can be moved as CSV, and how each row is validated. */
const TABLES: Record<string, { schema: ZodType<object>; columns: string[]; orderBy: string }> = {
  accounts: {
    schema: S.AccountCreate,
    columns: ["name", "institution", "category", "valuation_mode", "currency", "funding_mode",
              "mgmt_fee_balance_pct", "mgmt_fee_deposit_pct", "is_active", "notes"],
    orderBy: "id",
  },
  holdings: {
    schema: S.HoldingCreate,
    columns: ["account_id", "symbol", "display_name", "asset_class", "currency"],
    orderBy: "id",
  },
  prices: {
    schema: S.PriceCreate,
    columns: ["holding_id", "date", "price_minor", "currency"],
    orderBy: "date, holding_id",
  },
  transactions: {
    schema: S.TransactionCreate,
    columns: ["account_id", "holding_id", "date", "type", "amount_minor", "quantity",
              "price_minor", "contribution_part", "fee_kind", "currency", "note"],
    orderBy: "date, id",
  },
  valuations: {
    schema: S.ValuationCreate,
    columns: ["account_id", "date", "balance_minor", "currency"],
    orderBy: "date, account_id",
  },
  recurring_rules: {
    schema: S.RecurringRuleCreate,
    columns: ["account_id", "label", "frequency", "day_of_month", "amount_minor", "currency",
              "contribution_part", "start_date", "end_date", "auto_generate", "is_active"],
    orderBy: "id",
  },
  fx_rates: {
    schema: S.FxRateCreate,
    columns: ["date", "base_currency", "quote_currency", "rate"],
    orderBy: "date",
  },
  rsu_grants: {
    schema: S.RsuGrantCreate,
    columns: ["account_id", "symbol", "grant_date", "total_units", "grant_price_minor",
              "currency", "cliff_months", "vest_duration_months", "vest_frequency", "notes"],
    orderBy: "id",
  },
  rsu_vests: {
    schema: S.RsuVestCreate,
    columns: ["grant_id", "vest_date", "units", "price_at_vest_minor",
              "units_sold_to_cover_tax", "status"],
    orderBy: "vest_date, id",
  },
};

// ── CSV primitives (RFC-4180 enough for spreadsheet round-trips) ─────────────

function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(field); field = ""; }
    else field += c;
  }
  out.push(field);
  return out.map(f => f.trim());
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = splitLine(lines[0]).map(h => h.toLowerCase());
  const rows = lines.slice(1).map(line => {
    const vals = splitLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
  return { headers, rows };
}

const esc = (v: unknown): string => {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV is all strings; the schemas expect numbers and booleans. Coerce by column
 * name so a blank cell becomes null rather than 0 or "".
 */
function coerce(row: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(row)) {
    const v = raw.trim();
    if (v === "") { out[k] = null; continue; }
    if (/_minor$|_months$|^day_of_month$|_id$|^units|^quantity$|^total_units$|^rate$|_pct$|_tax$/.test(k)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : v;   // leave it for zod to reject
    } else if (k === "is_active" || k === "auto_generate") {
      out[k] = v === "1" || v.toLowerCase() === "true";
    } else {
      out[k] = v;
    }
  }
  return out;
}

// GET /api/export/csv/:table
csvRouter.get("/export/csv/:table", (req, res) => {
  const spec = TABLES[req.params.table];
  if (!spec) return fail(res, `Cannot export "${req.params.table}". Try: ${Object.keys(TABLES).join(", ")}`);
  try {
    const db = getDb();
    // id is included so an exported file can be diffed against the live data.
    const cols = ["id", ...spec.columns];
    const rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${req.params.table} ORDER BY ${spec.orderBy}`).all() as Record<string, unknown>[];
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.table}.csv"`);
    // BOM so Hebrew survives a round trip through Excel.
    res.send("﻿" + csv);
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/export/csv/:table/template — headers plus one example row
csvRouter.get("/export/csv/:table/template", (req, res) => {
  const spec = TABLES[req.params.table];
  if (!spec) return fail(res, `Unknown table "${req.params.table}"`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.table}-template.csv"`);
  res.send("﻿" + spec.columns.join(",") + "\r\n");
});

/**
 * POST /api/import/csv/:table  { content: "<csv>", mode?: "append" | "replace" }
 * Validates every row first; writes only if all pass, inside one transaction.
 */
csvRouter.post("/import/csv/:table", (req, res) => {
  const table = req.params.table;
  const spec = TABLES[table];
  if (!spec) return fail(res, `Cannot import "${table}". Try: ${Object.keys(TABLES).join(", ")}`);

  const { content, mode = "append" } = req.body as { content?: string; mode?: string };
  if (typeof content !== "string" || !content.trim()) return fail(res, "content (a CSV string) is required");
  if (mode !== "append" && mode !== "replace") return fail(res, 'mode must be "append" or "replace"');

  const { headers, rows } = parseCsv(content);
  if (rows.length === 0) return fail(res, "The CSV has a header but no data rows");

  const unknown = headers.filter(h => h !== "id" && !spec.columns.includes(h));
  if (unknown.length) {
    return fail(res, `Unknown column(s) for ${table}: ${unknown.join(", ")}. Expected: ${spec.columns.join(", ")}`);
  }

  // Validate everything before touching the DB.
  const valid: Record<string, unknown>[] = [];
  const errors: { row: number; message: string }[] = [];
  rows.forEach((raw, i) => {
    const parsed = spec.schema.safeParse(coerce(raw));
    if (parsed.success) valid.push(parsed.data as Record<string, unknown>);
    else errors.push({ row: i + 2, message: zodMessage(parsed.error) });   // +2: header + 1-index
  });

  if (errors.length) {
    return fail(res, `${errors.length} of ${rows.length} row(s) invalid — nothing was imported. ` +
      errors.slice(0, 5).map(e => `row ${e.row}: ${e.message}`).join(" | "));
  }

  try {
    const db = getDb();
    let inserted = 0;
    let deleted = 0;
    db.transaction(() => {
      if (mode === "replace") {
        deleted = db.prepare(`DELETE FROM ${table}`).run().changes;
      }
      for (const row of valid) {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (v === undefined) continue;
          data[k] = typeof v === "boolean" ? (v ? 1 : 0) : v;
        }
        const cols = Object.keys(data);
        db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
        ).run(...cols.map(c => data[c]));
        inserted++;
      }
    })();
    ok(res, { table, mode, inserted, deleted }, 201);
  } catch (e) {
    fail(res, `Import failed and was rolled back: ${(e as Error).message}`, 400);
  }
});

// GET /api/import/csv — what can be imported, and with which columns
csvRouter.get("/import/csv", (_req, res) => {
  ok(res, Object.fromEntries(Object.entries(TABLES).map(([t, s]) => [t, s.columns])));
});
