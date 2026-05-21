import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";

export const realizedRouter = Router();
realizedRouter.use(requireAuth);

// GET /api/realized?year=YYYY — annual summary + per-asset breakdown
realizedRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const from = `${year}-01-01T00:00:00Z`;
    const to   = `${year}-12-31T23:59:59Z`;

    const rows = db
      .prepare(
        `SELECT
           t.id, t.investment_id, t.kind, t.units, t.price_per_unit,
           t.total_amount, t.currency, t.occurred_at, t.realized_pl, t.notes,
           i.name AS investment_name, i.type AS investment_type, i.ticker
         FROM transactions t
         JOIN investments i ON i.id = t.investment_id
         WHERE t.user_id = ? AND t.kind IN ('SELL','DIV') AND t.occurred_at BETWEEN ? AND ?
         ORDER BY t.occurred_at DESC`
      )
      .all(req.user!.id, from, to) as any[];

    // Aggregate
    let total_realized = 0;
    let total_dividends = 0;
    let total_capital = 0;
    const byAsset = new Map<number, { name: string; ticker: string | null; type: string; realized: number; dividends: number; count: number }>();

    for (const r of rows) {
      const pl = r.realized_pl ?? 0;
      if (r.kind === "SELL") {
        total_capital += pl;
        total_realized += pl;
      } else if (r.kind === "DIV") {
        total_dividends += r.total_amount;
        total_realized += r.total_amount;
      }

      if (!byAsset.has(r.investment_id)) {
        byAsset.set(r.investment_id, {
          name: r.investment_name,
          ticker: r.ticker,
          type: r.investment_type,
          realized: 0,
          dividends: 0,
          count: 0,
        });
      }
      const entry = byAsset.get(r.investment_id)!;
      if (r.kind === "SELL") { entry.realized += pl; entry.count++; }
      if (r.kind === "DIV")  { entry.dividends += r.total_amount; entry.count++; }
    }

    ok(res, {
      year,
      summary: {
        total: total_realized,
        capital_gains: total_capital,
        dividends: total_dividends,
        trade_count: rows.filter(r => r.kind === "SELL").length,
      },
      by_asset: [...byAsset.entries()].map(([id, v]) => ({ investment_id: id, ...v })),
      transactions: rows,
    });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/realized/years — list years that have SELL or DIV transactions
realizedRouter.get("/years", (req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT
           CAST(strftime('%Y', occurred_at) AS INTEGER) AS year,
           SUM(CASE WHEN kind='SELL' THEN realized_pl ELSE 0 END) AS capital_gains,
           SUM(CASE WHEN kind='DIV'  THEN total_amount ELSE 0 END) AS dividends,
           COUNT(*) AS trade_count
         FROM transactions
         WHERE user_id = ? AND kind IN ('SELL','DIV')
         GROUP BY year
         ORDER BY year DESC`
      )
      .all(req.user!.id) as { year: number; capital_gains: number; dividends: number; trade_count: number }[];

    const years = rows.map(r => ({
      year: r.year,
      total: (r.capital_gains ?? 0) + (r.dividends ?? 0),
      capital_gains: r.capital_gains ?? 0,
      dividends: r.dividends ?? 0,
      count: r.trade_count,
    }));

    ok(res, { years });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/realized/tax-report?year=YYYY — Israeli Form 1399, UTF-8 BOM CSV download
realizedRouter.get("/tax-report", (req, res) => {
  try {
    const db = getDb();
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();
    const from = `${year}-01-01T00:00:00Z`;
    const to   = `${year}-12-31T23:59:59Z`;

    const sells = db.prepare(
      `SELECT t.occurred_at, t.units, t.price_per_unit, t.total_amount,
              t.currency, t.realized_pl, t.fx_rate_at_buy,
              i.name, i.ticker, i.type, i.isin
       FROM transactions t
       JOIN investments i ON i.id = t.investment_id
       WHERE t.user_id = ? AND t.kind = 'SELL' AND t.occurred_at BETWEEN ? AND ?
       ORDER BY t.occurred_at ASC`
    ).all(req.user!.id, from, to) as any[];

    const divs = db.prepare(
      `SELECT t.occurred_at, t.total_amount, t.currency,
              i.name, i.ticker, i.isin
       FROM transactions t
       JOIN investments i ON i.id = t.investment_id
       WHERE t.user_id = ? AND t.kind = 'DIV' AND t.occurred_at BETWEEN ? AND ?
       ORDER BY t.occurred_at ASC`
    ).all(req.user!.id, from, to) as any[];

    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines: string[] = [];

    // Headers in English per v1 spec. Hebrew column headers can be added in v2 if needed for direct tax-authority submission.
    // Capital Gains section
    lines.push("Type,Date,Asset,Ticker,ISIN,Units Sold,Sale Price,Proceeds,Currency,Realized P/L,FX Rate at Buy");
    for (const r of sells) {
      lines.push([
        esc("Securities Sale"),
        esc(r.occurred_at.slice(0, 10)),
        esc(r.name),
        esc(r.ticker ?? ""),
        esc(r.isin ?? ""),
        esc(r.units ?? ""),
        esc(r.price_per_unit ?? ""),
        esc(r.total_amount),
        esc(r.currency),
        esc(r.realized_pl ?? ""),
        esc(r.fx_rate_at_buy ?? ""),
      ].join(","));
    }

    lines.push("");
    // Dividends section
    lines.push("Type,Date,Asset,Ticker,ISIN,Amount,Currency");
    for (const r of divs) {
      lines.push([
        esc("Dividend"),
        esc(r.occurred_at.slice(0, 10)),
        esc(r.name),
        esc(r.ticker ?? ""),
        esc(r.isin ?? ""),
        esc(r.total_amount),
        esc(r.currency),
      ].join(","));
    }

    const BOM = "﻿";
    const csv = BOM + lines.join("\r\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="tax-report-${year}.csv"`);
    res.send(csv);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
