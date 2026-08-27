/**
 * The read endpoints that answer "what is my money doing": portfolio and
 * account summaries, decomposition series, the RSU schedule, and staleness.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { ok, fail } from "../middleware/respond.js";
import { zodMessage } from "../api/crud.js";
import * as S from "../api/schemas.js";
import {
  loadLedger, getAccount, displayCurrency, boolSetting, numSetting, staleAccounts,
} from "../calc/repo.js";
import {
  summarizeAccount, summarizePortfolio, accountSeries, portfolioSeries,
  firstActivityDate, forAccount, feesPaidByKindOn,
} from "../calc/engine.js";
import { eachDay, eachMonthEnd, today, type IsoDate } from "../calc/dates.js";
import { DEFAULT_OPTIONS, type CalcOptions, type Currency } from "../calc/types.js";
import { schedule as rsuSchedule, markVested } from "../calc/rsu.js";
import { previewUpcoming } from "../calc/recurring.js";

export const analyticsRouter = Router();

/** Calc options assembled from settings, so behaviour is configurable at runtime. */
function options(db: ReturnType<typeof getDb>): CalcOptions {
  return {
    rsuPrincipalBasis: boolSetting(db, "rsu_principal_at_vest_price")
      ? "vest_price" : "zero_cost",
    staleFxDays: numSetting(db, "stale_fx_days", DEFAULT_OPTIONS.staleFxDays),
    staleDataDays: numSetting(db, "stale_data_days", DEFAULT_OPTIONS.staleDataDays),
  };
}

function resolveDates(
  db: ReturnType<typeof getDb>, q: { from?: string; to?: string; granularity: "daily" | "monthly" }
): IsoDate[] {
  const ledger = loadLedger(db, { includeInactive: true });
  const to = q.to ?? today();
  const from = q.from ?? firstActivityDate(ledger) ?? to;
  return q.granularity === "daily" ? eachDay(from, to) : eachMonthEnd(from, to);
}

// GET /api/portfolio/summary?as_of=&currency=
analyticsRouter.get("/portfolio/summary", (req, res) => {
  const q = S.AsOfQuery.safeParse(req.query);
  if (!q.success) return fail(res, zodMessage(q.error));
  try {
    const db = getDb();
    markVested(db);   // keep vest statuses honest before valuing anything
    const ledger = loadLedger(db);
    const asOf = q.data.as_of ?? today();
    const ccy = (q.data.currency ?? displayCurrency(db)) as Currency;
    ok(res, summarizePortfolio(ledger, asOf, ccy, options(db)));
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/portfolio/series?from=&to=&granularity=
analyticsRouter.get("/portfolio/series", (req, res) => {
  const q = S.SeriesQuery.safeParse(req.query);
  if (!q.success) return fail(res, zodMessage(q.error));
  try {
    const db = getDb();
    const ledger = loadLedger(db);
    const ccy = (q.data.currency ?? displayCurrency(db)) as Currency;
    const dates = resolveDates(db, q.data);
    ok(res, {
      display_currency: ccy,
      granularity: q.data.granularity,
      points: portfolioSeries(ledger, dates, ccy, options(db)),
    });
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/accounts/:id/summary
analyticsRouter.get("/accounts/:id/summary", (req, res) => {
  const q = S.AsOfQuery.safeParse(req.query);
  if (!q.success) return fail(res, zodMessage(q.error));
  try {
    const db = getDb();
    const account = getAccount(db, Number(req.params.id));
    if (!account) return fail(res, "Account not found", 404);
    markVested(db);
    const ledger = loadLedger(db, { includeInactive: true });
    const asOf = q.data.as_of ?? today();
    const ccy = (q.data.currency ?? displayCurrency(db)) as Currency;
    const summary = summarizeAccount(ledger, account, asOf, ccy, options(db));
    ok(res, {
      ...summary,
      fees_by_kind_minor: feesPaidByKindOn(forAccount(ledger, account.id), asOf),
    });
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/accounts/:id/series
analyticsRouter.get("/accounts/:id/series", (req, res) => {
  const q = S.SeriesQuery.safeParse(req.query);
  if (!q.success) return fail(res, zodMessage(q.error));
  try {
    const db = getDb();
    const account = getAccount(db, Number(req.params.id));
    if (!account) return fail(res, "Account not found", 404);
    const ledger = loadLedger(db, { includeInactive: true });
    const ccy = (q.data.currency ?? displayCurrency(db)) as Currency;
    const dates = resolveDates(db, q.data);
    ok(res, {
      account_id: account.id,
      display_currency: ccy,
      granularity: q.data.granularity,
      points: accountSeries(ledger, account, dates, ccy, options(db)),
    });
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/rsu/schedule — every tranche, vested and upcoming
analyticsRouter.get("/rsu/schedule", (_req, res) => {
  try {
    const db = getDb();
    markVested(db);
    const rows = rsuSchedule(db);
    const vested = rows.filter(r => r.status === "vested");
    const scheduled = rows.filter(r => r.status === "scheduled");
    ok(res, {
      vests: rows,
      totals: {
        vested_units: vested.reduce((s, r) => s + r.units, 0),
        vested_net_units: vested.reduce((s, r) => s + r.net_units, 0),
        unvested_units: scheduled.reduce((s, r) => s + r.units, 0),
        needs_price_at_vest: vested.filter(r => r.price_at_vest_minor == null).length,
      },
      next_vest: scheduled[0] ?? null,
    });
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/data/stale?days=N — what needs a fresh number typed in
analyticsRouter.get("/data/stale", (req, res) => {
  try {
    const db = getDb();
    const days = Number(req.query.days ?? numSetting(db, "stale_data_days", DEFAULT_OPTIONS.staleDataDays));
    if (!Number.isFinite(days) || days < 0) return fail(res, "days must be a non-negative number");
    const asOf = today();
    const rows = staleAccounts(db, days, asOf);
    const fx = db.prepare(
      "SELECT MAX(date) d FROM fx_rates WHERE base_currency='USD' AND quote_currency='ILS'"
    ).get() as { d: string | null };
    ok(res, {
      as_of: asOf,
      threshold_days: days,
      accounts: rows,
      fx_last_date: fx.d,
      fx_is_stale: fx.d == null ||
        (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${fx.d}T00:00:00Z`)) / 86_400_000 > days,
    });
  } catch (e) { fail(res, (e as Error).message, 500); }
});

// GET /api/recurring/upcoming?horizon_months=
analyticsRouter.get("/recurring/upcoming", (req, res) => {
  try {
    const horizon = Number(req.query.horizon_months ?? 3);
    if (!Number.isFinite(horizon) || horizon < 1 || horizon > 36) {
      return fail(res, "horizon_months must be between 1 and 36");
    }
    ok(res, { as_of: today(), postings: previewUpcoming(getDb(), today(), horizon) });
  } catch (e) { fail(res, (e as Error).message, 500); }
});
