import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import { computePortfolio, today, type Currency } from "../services/valuation.js";
import { monthlySeries, pickDecomposition } from "./accounts.js";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

function displayCcy(req: { user?: { display_currency?: string } }): Currency {
  return (req.user?.display_currency === "USD" ? "USD" : "ILS");
}

// GET /api/portfolio?as_of=&currency= — the headline numbers:
// value, my money (principal), earnings, fees eaten — plus per-account detail.
portfolioRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const asOf = req.query.as_of ? String(req.query.as_of).slice(0, 10) : today();
    const ccy = req.query.currency ? String(req.query.currency) as Currency : displayCcy(req);
    ok(res, computePortfolio(db, req.user!.id, ccy, asOf));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/portfolio/history?from=&to= — month-end decomposition for the chart.
// Recomputed from the ledger on demand, so back-dating an entry corrects history
// instead of leaving a stale stored series behind.
portfolioRouter.get("/history", (req, res) => {
  try {
    const db = getDb();
    const ccy = req.query.currency ? String(req.query.currency) as Currency : displayCcy(req);
    const to = req.query.to ? String(req.query.to).slice(0, 10) : today();

    const firstRow = db.prepare(
      "SELECT MIN(occurred_on) AS first FROM entries WHERE user_id = ?"
    ).get(req.user!.id) as { first: string | null };

    if (!firstRow.first) return ok(res, { display_currency: ccy, points: [] });

    const from = req.query.from ? String(req.query.from).slice(0, 10) : firstRow.first;
    const points = monthlySeries(from, to, d =>
      pickDecomposition(asDisplay(computePortfolio(db, req.user!.id, ccy, d)))
    );

    ok(res, { display_currency: ccy, points });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

/** computePortfolio already reports in display currency; adapt the field names. */
function asDisplay(p: { value: number; principal: number; gross_earnings: number; fees: number }) {
  return {
    value_display: p.value,
    principal_display: p.principal,
    gross_earnings_display: p.gross_earnings,
    fees_display: p.fees,
  };
}
