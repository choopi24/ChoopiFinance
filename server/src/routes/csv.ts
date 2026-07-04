import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { recomputeRealized } from "../services/fifo.js";
import { takeSnapshot } from "../services/snapshot.js";

export const csvRouter = Router();
csvRouter.use(requireAuth);

// ── CSV parser helpers ────────────────────────────────────────────────────────

function splitLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '"' && line[j + 1] === '"') { j += 2; continue; }
        if (line[j] === '"') break;
        j++;
      }
      fields.push(line.slice(i + 1, j).replace(/""/g, '"').trim());
      i = j + 2;
    } else {
      const j = line.indexOf(",", i);
      if (j === -1) { fields.push(line.slice(i).trim()); break; }
      fields.push(line.slice(i, j).trim());
      i = j + 1;
    }
  }
  return fields;
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = splitLine(nonEmpty[0]).map(h => h.toLowerCase().trim());
  const rows: Record<string, string>[] = [];

  for (let n = 1; n < nonEmpty.length; n++) {
    const vals = splitLine(nonEmpty[n]);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    rows.push(row);
  }

  return { headers, rows };
}

// ── Wide-matrix helpers ───────────────────────────────────────────────────────

/** Parse D.M.YY → YYYY-MM-DD, returns null on failure */
function parseDMYY(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = 2000 + parseInt(y, 10);
  return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

type CellResult = { kind: "value"; n: number } | { kind: "empty" } | { kind: "invalid"; raw: string };

/** Strip currency symbols/commas and classify the cell value */
function parseCell(raw: string): CellResult {
  const s = raw.replace(/^["'\s]+|["'\s]+$/g, "").replace(/[₪,]/g, "").trim();
  if (!s || s === "-") return { kind: "empty" };
  const n = parseFloat(s);
  if (isNaN(n)) return { kind: "invalid", raw };
  return { kind: "value", n };
}

const SUGGESTED_NAMES: Record<string, string> = {
  "הפניקס קופת גמל": "Phoenix Provident Fund",
  "אלטשולר שחם חיסכון לכל ילד": "Altshuler Savings for Child",
  "כלל קרן השתלמות": "Klal Education Fund",
  "מגדל פנסיה": "Migdal Pension",
  "מנורה מבטחים קרן השתלמות": "Menora Education Fund",
};

function suggestName(raw: string): string {
  const trimmed = raw.trim();
  return SUGGESTED_NAMES[trimmed] ?? trimmed;
}

function detectType(name: string): "pension" | "gemel" | "education" | "money_market" | "other" {
  if (name.includes("פנסיה")) return "pension";
  if (name.includes("השתלמות")) return "education";
  if (name.includes("כספית")) return "money_market";
  if (name.includes("גמל")) return "gemel";
  return "other";
}

interface FundSnapshot { date: string; value: number }

interface ParsedFund {
  originalName: string;
  suggestedName: string;
  detectedType: ReturnType<typeof detectType>;
  snapshots: FundSnapshot[];
}

interface WideMatrixResult {
  funds: ParsedFund[];
  errors: { row: number; field: string; message: string }[];
  skipped_cells: number;
}

function parseWideMatrix(content: string): WideMatrixResult {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  const errors: { row: number; field: string; message: string }[] = [];

  if (lines.length < 2) {
    return { funds: [], errors: [{ row: 1, field: "file", message: "CSV must have a header row and at least one data row" }], skipped_cells: 0 };
  }

  const headers = splitLine(lines[0]);
  if (headers.length < 2) {
    return { funds: [], errors: [{ row: 1, field: "header", message: "CSV must have at least 2 columns (1 fund + date)" }], skipped_cells: 0 };
  }

  // All columns except the last are fund columns; last column contains dates
  const fundCount = headers.length - 1;
  const fundNames: string[] = [];

  for (let fi = 0; fi < fundCount; fi++) {
    const name = headers[fi].trim();
    if (!name) {
      errors.push({ row: 1, field: `column_${fi + 1}`, message: `Blank fund header at column ${fi + 1}` });
      fundNames.push(`Fund ${fi + 1}`);
    } else {
      fundNames.push(name);
    }
  }

  const funds: ParsedFund[] = fundNames.map(name => ({
    originalName: name,
    suggestedName: suggestName(name),
    detectedType: detectType(name),
    snapshots: [],
  }));

  let skipped_cells = 0;
  const datesSeen = new Set<string>();

  for (let li = 1; li < lines.length; li++) {
    const rowNum = li + 1;
    const cells = splitLine(lines[li]);

    const rawDate = cells[cells.length - 1]?.trim() ?? "";
    const isoDate = parseDMYY(rawDate);

    if (!isoDate) {
      errors.push({ row: rowNum, field: "date", message: `Cannot parse date "${rawDate}" — expected D.M.YY format` });
      continue;
    }
    if (datesSeen.has(isoDate)) {
      errors.push({ row: rowNum, field: "date", message: `Duplicate date ${isoDate}` });
      continue;
    }
    datesSeen.add(isoDate);

    for (let fi = 0; fi < fundCount; fi++) {
      const raw = cells[fi] ?? "";
      const result = parseCell(raw);
      if (result.kind === "empty") {
        skipped_cells++;
      } else if (result.kind === "invalid") {
        errors.push({ row: rowNum, field: fundNames[fi], message: `Invalid value "${result.raw}"` });
      } else {
        funds[fi].snapshots.push({ date: isoDate, value: result.n });
      }
    }
  }

  for (const fund of funds) {
    fund.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }

  return { funds, errors, skipped_cells };
}

// ── Validators per type ───────────────────────────────────────────────────────

type ValidationError = { row: number; field: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_CURRENCIES = new Set(["NIS", "USD"]);

function validateDate(v: string, row: number, field: string): ValidationError | null {
  if (!ISO_DATE.test(v)) return { row, field, message: `Must be YYYY-MM-DD, got "${v}"` };
  const d = new Date(v);
  if (isNaN(d.getTime())) return { row, field, message: `Invalid date "${v}"` };
  return null;
}

function validatePositiveNum(v: string, row: number, field: string): ValidationError | null {
  const n = Number(v);
  if (isNaN(n) || n <= 0) return { row, field, message: `Must be a positive number, got "${v}"` };
  return null;
}

function validateCurrency(v: string, row: number, field: string): ValidationError | null {
  const upper = v.toUpperCase();
  if (!VALID_CURRENCIES.has(upper)) {
    return { row, field, message: `Must be NIS or USD, got "${v}"` };
  }
  return null;
}

function required(v: string, row: number, field: string): ValidationError | null {
  if (!v || !v.trim()) return { row, field, message: `Required field is empty` };
  return null;
}

function validateTradeRow(
  r: Record<string, string>,
  n: number,
  kindField = "kind",
  sharesField = "units",
  priceField = "price_per_unit",
): ValidationError[] {
  const errs: ValidationError[] = [];
  const push = (e: ValidationError | null) => { if (e) errs.push(e); };

  push(required(r[kindField], n, kindField));
  if (r[kindField] && !["BUY", "SELL", "DIV"].includes(r[kindField].toUpperCase())) {
    errs.push({ row: n, field: kindField, message: `Must be BUY, SELL, or DIV` });
  }
  push(validatePositiveNum(r[sharesField] || "0", n, sharesField));
  push(validatePositiveNum(r[priceField] || "0", n, priceField));

  return errs;
}

type AssetType = "crypto" | "stock" | "etf" | "pension" | "gemel" | "education" | "money_market" | "other";

const MANUAL_CSV_TYPES = new Set<AssetType>(["pension", "gemel", "education", "money_market", "other"]);

function validateRows(type: AssetType, rows: Record<string, string>[]): {
  errors: ValidationError[];
  valid: Record<string, string>[];
  invalid: number[];
} {
  const errors: ValidationError[] = [];
  const invalid = new Set<number>();

  function addErr(e: ValidationError | null) {
    if (!e) return;
    errors.push(e);
    invalid.add(e.row);
  }

  rows.forEach((r, i) => {
    const n = i + 2;

    if (type === "crypto") {
      addErr(required(r.ticker,         n, "ticker"));
      addErr(required(r.currency,       n, "currency"));
      addErr(required(r.date,           n, "date"));
      if (r.date) addErr(validateDate(r.date, n, "date"));
      if (r.currency) addErr(validateCurrency(r.currency, n, "currency"));
      validateTradeRow(r, n, "kind", "units", "price_per_unit").forEach(e => addErr(e));
    }

    if (type === "stock") {
      addErr(required(r.ticker,     n, "ticker"));
      addErr(required(r.currency,   n, "currency"));
      addErr(required(r.date,       n, "date"));
      if (r.date) addErr(validateDate(r.date, n, "date"));
      if (r.currency) addErr(validateCurrency(r.currency, n, "currency"));
      validateTradeRow(r, n, "kind", "shares", "price_per_share").forEach(e => addErr(e));
    }

    if (type === "etf") {
      addErr(required(r.ticker,     n, "ticker"));
      addErr(required(r.currency,   n, "currency"));
      addErr(required(r.date,       n, "date"));
      if (r.date) addErr(validateDate(r.date, n, "date"));
      if (r.currency) addErr(validateCurrency(r.currency, n, "currency"));
      validateTradeRow(r, n, "kind", "shares", "price_per_share").forEach(e => addErr(e));
      if (r.etf_kind && !["accumulating", "distributing"].includes(r.etf_kind.toLowerCase())) {
        addErr({ row: n, field: "etf_kind", message: "Must be accumulating or distributing" });
      }
    }

    if (MANUAL_CSV_TYPES.has(type)) {
      const amountField = type === "other" ? "invested_amount" : "balance";
      addErr(required(r.name,        n, "name"));
      addErr(required(r[amountField], n, amountField));
      addErr(required(r.currency,    n, "currency"));
      addErr(required(r.date,        n, "date"));
      if (r.date) addErr(validateDate(r.date, n, "date"));
      if (r.currency) addErr(validateCurrency(r.currency, n, "currency"));
      if (r[amountField]) addErr(validatePositiveNum(r[amountField], n, amountField));
      if (type === "education" && r.liquid_date && r.liquid_date.trim()) {
        addErr(validateDate(r.liquid_date, n, "liquid_date"));
      }
    }
  });

  const validRows = rows.filter((_, i) => !invalid.has(i + 2));
  return { errors, valid: validRows, invalid: [...invalid] };
}

// ── POST /api/csv/preview/:type ───────────────────────────────────────────────

csvRouter.post("/preview/:type", (req, res) => {
  try {
    const type = req.params.type as AssetType;
    const VALID_TYPES: AssetType[] = ["crypto", "stock", "etf", "pension", "gemel", "education", "money_market", "other"];
    if (!VALID_TYPES.includes(type)) return fail(res, `Invalid type: ${type}`);

    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string") return fail(res, "content (CSV string) is required");

    const { rows } = parseCsv(content);
    if (rows.length === 0) return fail(res, "CSV has no data rows");

    const { errors, valid, invalid } = validateRows(type, rows);

    ok(res, {
      rows_total: rows.length,
      rows_valid: valid.length,
      rows_invalid: invalid.length,
      errors,
      preview_rows: valid.slice(0, 5),
    });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// ── POST /api/csv/import/:type ────────────────────────────────────────────────

csvRouter.post("/import/:type", (req, res) => {
  try {
    const type = req.params.type as AssetType;
    const { content } = req.body as { content?: string };
    if (!content) return fail(res, "content is required");

    const db = getDb();
    const uid = req.user!.id;
    const { rows } = parseCsv(content);
    const { errors, valid } = validateRows(type, rows);

    if (errors.length > 0) return fail(res, "CSV has validation errors — re-run preview first");
    if (valid.length === 0) return fail(res, "No valid rows to import");

    let investments_created = 0;
    let transactions_created = 0;
    const affectedInvestmentIds = new Set<number>();

    db.transaction(() => {
      if (type === "crypto" || type === "stock" || type === "etf") {
        const byTicker = new Map<string, typeof valid>();
        for (const r of valid) {
          const t = r.ticker.toUpperCase();
          if (!byTicker.has(t)) byTicker.set(t, []);
          byTicker.get(t)!.push(r);
        }

        for (const [ticker, trows] of byTicker) {
          let inv = db
            .prepare("SELECT id FROM investments WHERE user_id = ? AND ticker = ? AND type = ? AND deleted_at IS NULL")
            .get(uid, ticker, type) as { id: number } | undefined;

          if (!inv) {
            const firstRow = trows[0];
            const name = type === "crypto" ? (firstRow.exchange || ticker) : (firstRow.broker || ticker);
            const insertInv = db.prepare(
              `INSERT INTO investments (user_id, type, name, ticker, isin, broker, etf_kind)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(
              uid, type,
              name,
              ticker,
              firstRow.isin || null,
              firstRow.broker || firstRow.exchange || null,
              (type === "etf" && firstRow.etf_kind) ? firstRow.etf_kind.toLowerCase() : null,
            );
            inv = { id: insertInv.lastInsertRowid as number };
            investments_created++;
          }

          for (const r of trows) {
            const kind = (r.kind || "BUY").toUpperCase();
            const unitsVal = Number(r.units ?? r.shares);
            const priceVal = Number(r.price_per_unit ?? r.price_per_share);
            const total = unitsVal * priceVal;
            const cur = (r.currency || "NIS").toUpperCase();
            const occurredAt = `${r.date}T12:00:00Z`;

            db.prepare(
              `INSERT INTO transactions
                 (investment_id, user_id, kind, units, price_per_unit, total_amount, currency, occurred_at, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(inv!.id, uid, kind, unitsVal, priceVal, total, cur, occurredAt, r.notes || null);

            transactions_created++;
            affectedInvestmentIds.add(inv!.id);
          }
        }
      } else {
        // Manual types: each row → one investment + one UPDATE transaction
        const amountField = type === "other" ? "invested_amount" : "balance";

        for (const r of valid) {
          const insertInv = db.prepare(
            `INSERT INTO investments (user_id, type, name, liquid_date)
             VALUES (?, ?, ?, ?)`
          ).run(
            uid, type, r.name.trim(),
            (type === "education" && r.liquid_date) ? r.liquid_date : null
          );
          const invId = insertInv.lastInsertRowid as number;
          investments_created++;

          const amount = Number(r[amountField]);
          const cur = (r.currency || "NIS").toUpperCase();
          const occurredAt = `${r.date}T12:00:00Z`;

          db.prepare(
            `INSERT INTO transactions
               (investment_id, user_id, kind, total_amount, currency, occurred_at, notes)
             VALUES (?, ?, 'UPDATE', ?, ?, ?, ?)`
          ).run(invId, uid, amount, cur, occurredAt, r.notes || null);
          transactions_created++;
        }
      }

      for (const id of affectedInvestmentIds) {
        recomputeRealized(db, id);
      }
    })();

    takeSnapshot(db, uid);
    ok(res, { investments_created, transactions_created }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// ── POST /api/csv/preview-matrix ─────────────────────────────────────────────

csvRouter.post("/preview-matrix", (req, res) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string") return fail(res, "content (CSV string) is required");

    const { funds, errors, skipped_cells } = parseWideMatrix(content);

    const previews = funds.map(f => {
      const earliest = f.snapshots[0];
      const latest   = f.snapshots[f.snapshots.length - 1];
      const gain     = (earliest && latest) ? latest.value - earliest.value : 0;
      const gainPct  = (earliest && earliest.value > 0) ? (gain / earliest.value) * 100 : 0;
      return {
        originalName:  f.originalName,
        suggestedName: f.suggestedName,
        detectedType:  f.detectedType,
        snapshotCount: f.snapshots.length,
        earliestDate:  earliest?.date ?? null,
        latestDate:    latest?.date   ?? null,
        earliestValue: earliest?.value ?? 0,
        latestValue:   latest?.value   ?? 0,
        gain,
        gainPct,
      };
    });

    ok(res, { funds: previews, errors, skipped_cells });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// ── POST /api/csv/import-matrix ───────────────────────────────────────────────

interface FundImportSpec {
  originalName: string;
  name: string;
  type: string;
}

csvRouter.post("/import-matrix", (req, res) => {
  try {
    const { content, funds: fundSpecs } = req.body as { content?: string; funds?: FundImportSpec[] };
    if (!content || typeof content !== "string") return fail(res, "content is required");
    if (!Array.isArray(fundSpecs) || fundSpecs.length === 0) return fail(res, "funds array is required");

    const db = getDb();
    const uid = req.user!.id;

    const { funds, errors } = parseWideMatrix(content);
    if (errors.length > 0) return fail(res, "CSV has validation errors — re-run preview first");

    const VALID_TYPES = new Set(["pension", "gemel", "education", "money_market", "other"]);
    let investments_created = 0;
    let transactions_created = 0;

    db.transaction(() => {
      for (const parsedFund of funds) {
        if (parsedFund.snapshots.length === 0) continue;

        const spec = fundSpecs.find(s => s.originalName === parsedFund.originalName);
        const fundType = spec && VALID_TYPES.has(spec.type) ? spec.type : parsedFund.detectedType;
        const fundName = ((spec?.name) || parsedFund.suggestedName).trim() || parsedFund.originalName.trim();

        const insertInv = db.prepare(
          `INSERT INTO investments (user_id, type, name) VALUES (?, ?, ?)`
        ).run(uid, fundType, fundName);
        const invId = insertInv.lastInsertRowid as number;
        investments_created++;

        for (const snap of parsedFund.snapshots) {
          db.prepare(
            `INSERT INTO transactions (investment_id, user_id, kind, total_amount, currency, occurred_at)
             VALUES (?, ?, 'UPDATE', ?, 'NIS', ?)`
          ).run(invId, uid, snap.value, `${snap.date}T12:00:00Z`);
          transactions_created++;
        }
      }
    })();

    takeSnapshot(db, uid);
    ok(res, { investments_created, transactions_created }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
