/**
 * CSV in and out, one table at a time.
 *
 * Spreadsheets are how a manually-entered ledger actually gets bulk-loaded —
 * typing two years of month-end balances on a phone is not a plan. Import is
 * additive and upserts on the same natural keys the POST endpoints use, so
 * re-importing a corrected file fixes rows instead of duplicating them.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import { badRequest } from "./_validate.js";

export const csvRouter = Router();
csvRouter.use(requireAuth);

/** Tables that can be round-tripped, with the query used to export them. */
const EXPORTS: Record<string, string> = {
  accounts: "SELECT * FROM accounts ORDER BY id",
  holdings: `SELECT h.*, a.name AS account_name FROM holdings h
             JOIN accounts a ON a.id = h.account_id ORDER BY h.id`,
  transactions: `SELECT t.*, a.name AS account_name, h.symbol AS holding_symbol
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 LEFT JOIN holdings h ON h.id = t.holding_id ORDER BY t.date, t.id`,
  prices: `SELECT p.*, h.symbol FROM prices p JOIN holdings h ON h.id = p.holding_id
           ORDER BY p.date, p.id`,
  valuations: `SELECT v.*, a.name AS account_name FROM valuations v
               JOIN accounts a ON a.id = v.account_id ORDER BY v.date, v.id`,
  fx_rates: "SELECT * FROM fx_rates ORDER BY date, id",
  rsu_grants: "SELECT * FROM rsu_grants ORDER BY id",
  rsu_vests: "SELECT * FROM rsu_vests ORDER BY vest_date, id",
  recurring_rules: "SELECT * FROM recurring_rules ORDER BY id",
};

/** RFC 4180 quoting: quote when the value contains a comma, quote or newline. */
function cell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n");
}

/** Split one CSV line, honouring quotes and doubled quotes inside them. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter(l => l.trim() !== "");
  if (lines.length < 2) return [];
  const cols = splitLine(lines[0]).map(c => c.trim());
  return lines.slice(1).map(line => {
    const cells = splitLine(line);
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? "").trim()]));
  });
}

/** GET /api/csv/:table */
csvRouter.get("/:table", (req, res) => {
  const table = req.params.table;
  const sql = EXPORTS[table];
  if (!sql) throw badRequest(`Cannot export "${table}". Try: ${Object.keys(EXPORTS).join(", ")}`);

  const rows = getDb().prepare(sql).all() as Record<string, unknown>[];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="choopi-${table}-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send(toCsv(rows));
});

/** The three series that are worth bulk-loading, each keyed by a lookup name. */
const IMPORTERS: Record<string, {
  required: string[];
  run: (db: ReturnType<typeof getDb>, row: Record<string, string>) => void;
}> = {
  prices: {
    required: ["symbol", "date", "price_minor"],
    run: (db, row) => {
      const h = db.prepare("SELECT id, currency FROM holdings WHERE symbol = ? COLLATE NOCASE")
        .get(row.symbol) as { id: number; currency: string } | undefined;
      if (!h) throw badRequest(`No holding with symbol "${row.symbol}"`);
      db.prepare(
        `INSERT INTO prices (holding_id, date, price_minor, currency) VALUES (?, ?, ?, ?)
         ON CONFLICT (holding_id, date) DO UPDATE SET price_minor = excluded.price_minor`
      ).run(h.id, row.date, Math.round(Number(row.price_minor)), row.currency || h.currency);
    },
  },
  valuations: {
    required: ["account_name", "date", "balance_minor"],
    run: (db, row) => {
      const a = db.prepare("SELECT id, currency FROM accounts WHERE name = ? COLLATE NOCASE")
        .get(row.account_name) as { id: number; currency: string } | undefined;
      if (!a) throw badRequest(`No account named "${row.account_name}"`);
      db.prepare(
        `INSERT INTO valuations (account_id, date, balance_minor, currency) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, date) DO UPDATE SET balance_minor = excluded.balance_minor`
      ).run(a.id, row.date, Math.round(Number(row.balance_minor)), row.currency || a.currency);
    },
  },
  fx_rates: {
    required: ["date", "base_currency", "quote_currency", "rate"],
    run: (db, row) => {
      db.prepare(
        `INSERT INTO fx_rates (date, base_currency, quote_currency, rate) VALUES (?, ?, ?, ?)
         ON CONFLICT (date, base_currency, quote_currency) DO UPDATE SET rate = excluded.rate`
      ).run(row.date, row.base_currency, row.quote_currency, Number(row.rate));
    },
  },
};

/**
 * POST /api/csv/:table — body { csv: "..." }.
 *
 * All-or-nothing: one bad row aborts the whole file with the line number, so a
 * half-imported price series can never silently skew a chart.
 */
csvRouter.post("/:table", (req, res) => {
  const db = getDb();
  const table = req.params.table;
  const importer = IMPORTERS[table];
  if (!importer) {
    throw badRequest(`Cannot import "${table}". Try: ${Object.keys(IMPORTERS).join(", ")}`);
  }

  const { csv } = req.body as { csv?: string };
  if (typeof csv !== "string" || !csv.trim()) throw badRequest("csv body field is required");

  const rows = parseCsv(csv);
  if (!rows.length) throw badRequest("No data rows found — is the header line present?");

  const missing = importer.required.filter(c => !(c in rows[0]));
  if (missing.length) {
    throw badRequest(`Missing column(s): ${missing.join(", ")}. Required: ${importer.required.join(", ")}`);
  }

  db.transaction(() => {
    rows.forEach((row, i) => {
      try {
        importer.run(db, row);
      } catch (e) {
        throw badRequest(`Line ${i + 2}: ${(e as Error).message}`);
      }
    });
  })();

  ok(res, { table, imported: rows.length }, 201);
});
