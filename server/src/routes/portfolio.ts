/**
 * Everything the dashboard reads.
 *
 * All figures come back already converted to the display currency, because the
 * conversion is date-dependent (each point uses the rate in force on its own
 * date) and the client has no business redoing that arithmetic.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import {
  accountValueOn, addMonths, daysBetween, feesPaidByKindOn, forAccount, loadLedger,
  portfolioSeries, priceOn, resolveFx, scaleMinor, staleAccounts, summarizePortfolio,
  unitsHeldOn,
  type Currency, type FxRow,
} from "../calc/index.js";
import { calcOptions, RANGES, rangeDates, requestCurrency, type Range } from "./_context.js";
import { qDate, qEnum, qInt } from "./_validate.js";

export const portfolioRouter = Router();
portfolioRouter.use(requireAuth);

/** GET /api/portfolio/summary — the three headline numbers, plus per account. */
portfolioRouter.get("/summary", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const currency = requestCurrency(req, db);
  const ledger = loadLedger(db);
  ok(res, summarizePortfolio(ledger, asOf, currency, calcOptions(db)));
});

/**
 * GET /api/portfolio/series?range=3M|1Y|YTD|ALL — the stacked-area source.
 *
 * `per_account` rides along so tapping a point can break it down by account
 * without a second round trip.
 */
portfolioRouter.get("/series", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const range = qEnum<Range>(req, "range", RANGES, "1Y");
  const currency = requestCurrency(req, db);
  const options = calcOptions(db);
  const ledger = loadLedger(db);
  const dates = rangeDates(ledger, range, asOf);

  const perAccount = ledger.accounts.map(a => {
    const scoped = forAccount(ledger, a.id);
    return {
      account_id: a.id,
      name: a.name,
      category: a.category,
      values: dates.map(date => {
        const v = accountValueOn(scoped, a, date, options);
        const fx = resolveFx(ledger.fx, a.currency, currency, date, options.staleFxDays);
        return scaleMinor(v.value_minor, fx.rate);
      }),
    };
  });

  ok(res, {
    range,
    display_currency: currency,
    points: portfolioSeries(ledger, dates, currency, options),
    per_account: perAccount,
  });
});

/**
 * GET /api/portfolio/allocation?by=category|asset_class
 *
 * Market accounts are split across their holdings by market value, so a
 * brokerage holding both an ETF and a single stock lands in two slices rather
 * than one. Balance-valued Israeli products have no instrument breakdown, so
 * under asset_class they aggregate into one savings slice.
 */
portfolioRouter.get("/allocation", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const by = qEnum(req, "by", ["category", "asset_class"] as const, "category");
  const currency = requestCurrency(req, db);
  const options = calcOptions(db);
  const ledger = loadLedger(db);

  const buckets = new Map<string, number>();
  const add = (key: string, minor: number) => buckets.set(key, (buckets.get(key) ?? 0) + minor);

  for (const account of ledger.accounts) {
    const scoped = forAccount(ledger, account.id);
    const v = accountValueOn(scoped, account, asOf, options);
    const fx = resolveFx(ledger.fx, account.currency, currency, asOf, options.staleFxDays);
    const display = (m: number) => scaleMinor(m, fx.rate);

    if (by === "category") { add(account.category, display(v.value_minor)); continue; }
    if (account.valuation_mode === "balance") { add("savings", display(v.value_minor)); continue; }
    if (account.category === "rsu") { add("rsu", display(v.value_minor)); continue; }

    for (const h of scoped.holdings) {
      const units = unitsHeldOn(scoped, h.id, asOf);
      if (Math.abs(units) < 1e-9) continue;
      const p = priceOn(scoped, h.id, asOf);
      if (!p) continue;
      add(h.asset_class, display(Math.round(units * p.price_minor)));
    }
    if (v.cash_minor !== 0) add("cash", display(v.cash_minor));
  }

  const slices = [...buckets.entries()]
    .map(([key, value_minor]) => ({ key, value_minor }))
    .filter(s => s.value_minor !== 0)
    .sort((a, b) => b.value_minor - a.value_minor);
  const total = slices.reduce((s, x) => s + x.value_minor, 0);

  ok(res, {
    as_of: asOf, by, display_currency: currency, total_minor: total,
    slices: slices.map(s => ({ ...s, share_pct: total ? (s.value_minor / total) * 100 : 0 })),
  });
});

/**
 * GET /api/portfolio/fees-monthly?months=12
 *
 * Every fee transaction, bucketed by calendar month and split by kind, each
 * converted at the rate in force on its own date.
 */
portfolioRouter.get("/fees-monthly", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const months = qInt(req, "months", 12, 120);
  const currency = requestCurrency(req, db);
  const options = calcOptions(db);
  const ledger = loadLedger(db, { includeInactive: true });

  const from = `${addMonths(asOf, -(months - 1)).slice(0, 7)}-01`;
  const byMonth = new Map<string, { total_minor: number; by_kind: Record<string, number> }>();

  // Seed every month in the window so a fee-free month shows as a zero bar
  // rather than vanishing and compressing the axis.
  for (let i = months - 1; i >= 0; i--) {
    byMonth.set(addMonths(asOf, -i).slice(0, 7), { total_minor: 0, by_kind: {} });
  }

  const accountCurrency = new Map<number, Currency>(
    ledger.accounts.map(a => [a.id, a.currency])
  );
  for (const t of ledger.transactions) {
    if (t.type !== "fee" || t.date < from || t.date > asOf) continue;
    const bucket = byMonth.get(t.date.slice(0, 7));
    if (!bucket) continue;
    const fx = resolveFx(
      ledger.fx, accountCurrency.get(t.account_id) ?? "ILS", currency, t.date, options.staleFxDays
    );
    const amount = Math.abs(scaleMinor(t.amount_minor, fx.rate));
    bucket.total_minor += amount;
    const kind = t.fee_kind ?? "other";
    bucket.by_kind[kind] = (bucket.by_kind[kind] ?? 0) + amount;
  }

  const rows = [...byMonth.entries()].map(([month, v]) => ({ month, ...v }));
  ok(res, {
    display_currency: currency,
    months: rows,
    window_total_minor: rows.reduce((s, r) => s + r.total_minor, 0),
    by_kind_to_date: feesPaidByKindOn(ledger, asOf),
  });
});

/**
 * GET /api/portfolio/attention — the dashboard strip.
 *
 * Everything here is a data-entry gap, not an error: the app has no feed to
 * fall back on, so anything it cannot value is something only you can fix.
 */
portfolioRouter.get("/attention", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const currency = requestCurrency(req, db);
  const options = calcOptions(db);
  const ledger = loadLedger(db);
  const fxRows = db.prepare(
    "SELECT date, base_currency, quote_currency, rate FROM fx_rates ORDER BY date"
  ).all() as FxRow[];

  type Item = {
    kind: "no_data" | "stale_data" | "missing_price" | "missing_fx" | "stale_fx" | "unposted_rule";
    severity: "warn" | "info";
    title: string;
    detail: string;
    action: "update_balance" | "update_price" | "add_fx" | "open_account";
    account_id?: number;
    holding_id?: number;
  };
  const items: Item[] = [];

  for (const s of staleAccounts(db, options.staleDataDays, asOf)) {
    const isBalance = s.valuation_mode === "balance";
    const action = isBalance ? "update_balance" : "update_price";
    items.push(s.last_data_date == null
      ? {
          kind: "no_data", severity: "warn", account_id: s.id, title: s.name, action,
          detail: isBalance ? "No balance has ever been entered" : "No price has ever been entered",
        }
      : {
          kind: "stale_data", severity: "warn", account_id: s.id, title: s.name, action,
          detail: `${isBalance ? "Balance" : "Price"} last updated ${daysBetween(s.last_data_date, asOf)} days ago`,
        });
  }

  // A holding you still own but have never priced is invisible in every total.
  for (const account of ledger.accounts) {
    const scoped = forAccount(ledger, account.id);
    for (const h of scoped.holdings) {
      if (Math.abs(unitsHeldOn(scoped, h.id, asOf)) < 1e-9) continue;
      if (priceOn(scoped, h.id, asOf)) continue;
      items.push({
        kind: "missing_price", severity: "warn", account_id: account.id, holding_id: h.id,
        title: `${h.symbol} · ${account.name}`,
        detail: "Units are held but no price has been entered — this holding counts as zero",
        action: "update_price",
      });
    }
  }

  // FX only matters for currencies actually in play.
  for (const base of new Set(ledger.accounts.map(a => a.currency).filter(c => c !== currency))) {
    const r = resolveFx(fxRows, base, currency, asOf, options.staleFxDays);
    if (r.missing) {
      items.push({
        kind: "missing_fx", severity: "warn", title: `${base} → ${currency}`, action: "add_fx",
        detail: `No exchange rate entered — ${base} accounts are being counted at 1:1`,
      });
    } else if (r.stale && r.rate_date) {
      items.push({
        kind: "stale_fx", severity: "info", title: `${base} → ${currency}`, action: "add_fx",
        detail: `Newest rate is from ${r.rate_date} (${daysBetween(r.rate_date, asOf)} days ago)`,
      });
    }
  }

  // A rule with auto-posting off will never post by itself.
  const manualRules = db.prepare(`
    SELECT r.id, r.label, a.id AS account_id, a.name AS account_name
    FROM recurring_rules r JOIN accounts a ON a.id = r.account_id
    WHERE r.is_active = 1 AND r.auto_generate = 0 AND r.start_date <= ?
  `).all(asOf) as { id: number; label: string | null; account_id: number; account_name: string }[];
  for (const r of manualRules) {
    items.push({
      kind: "unposted_rule", severity: "info", account_id: r.account_id,
      title: r.label ?? r.account_name,
      detail: "Auto-posting is off for this rule — deposits must be added by hand",
      action: "open_account",
    });
  }

  ok(res, { as_of: asOf, count: items.length, items });
});
