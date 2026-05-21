import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { computePortfolio, getUsdNisRate } from "../services/portfolio.js";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

// GET /api/portfolio
portfolioRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const summary = computePortfolio(db, req.user!.id);
    ok(res, summary);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/portfolio/snapshot  — store current state in portfolio_snapshots
portfolioRouter.post("/snapshot", (req, res) => {
  try {
    const db = getDb();
    const { total_value_nis, total_net_deposited_nis } = computePortfolio(db, req.user!.id);
    const fx = getUsdNisRate(db);
    const total_value_usd = total_value_nis / fx.rate;
    const total_net_deposited_usd = total_net_deposited_nis / fx.rate;

    const row = db.prepare(
      `INSERT INTO portfolio_snapshots
         (user_id, total_value_nis, total_value_usd, total_net_deposited_nis, total_net_deposited_usd)
       VALUES (?, ?, ?, ?, ?)`
    ).run(req.user!.id, total_value_nis, total_value_usd, total_net_deposited_nis, total_net_deposited_usd);

    ok(res, { id: row.lastInsertRowid }, 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/portfolio/history?range=1M|3M|1Y|ALL
portfolioRouter.get("/history", (req, res) => {
  try {
    const db = getDb();
    const range = (req.query.range as string) ?? "1Y";

    const cutoffs: Record<string, string> = {
      "1M": new Date(Date.now() - 30  * 86_400_000).toISOString(),
      "3M": new Date(Date.now() - 90  * 86_400_000).toISOString(),
      "1Y": new Date(Date.now() - 365 * 86_400_000).toISOString(),
      "ALL": "1970-01-01T00:00:00Z",
    };
    const cutoff = cutoffs[range] ?? cutoffs["1Y"];

    const rows = db
      .prepare(
        `SELECT snapshot_at, total_value_nis, total_value_usd,
                total_net_deposited_nis, total_net_deposited_usd
         FROM portfolio_snapshots
         WHERE user_id = ? AND snapshot_at >= ?
         ORDER BY snapshot_at ASC`
      )
      .all(req.user!.id, cutoff);

    ok(res, { range, snapshots: rows });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});
