/**
 * Accounts and the holdings inside them.
 *
 * Every DELETE returns the row it removed. That is what makes the client's
 * undo toast possible without a server-side trash table: undo simply POSTs the
 * returned row back.
 */

import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok } from "../middleware/respond.js";
import {
  getAccount, loadLedger, summarizeAccount,
  type AccountRow,
} from "../calc/index.js";
import {
  calcOptions, decomposeSeries, projectAccount, projectionQuery, RANGES,
  requestCurrency, seriesDates, type Range,
} from "./_context.js";
import {
  ASSET_CLASSES, CATEGORIES, CURRENCIES, FUNDING_MODES, VALUATION_MODES,
  HttpError, absent, bool, enumOf, intParam, notFound, optNum, optStr,
  qDate, qEnum, str,
} from "./_validate.js";

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

const load = (includeInactive: boolean) => loadLedger(getDb(), { includeInactive });

/** GET /api/accounts — every account with its full decomposition. */
accountsRouter.get("/", (req, res) => {
  const db = getDb();
  const includeInactive = req.query.include_inactive === "true";
  const asOf = qDate(req, "as_of");
  const currency = requestCurrency(req, db);
  const options = calcOptions(db);
  const ledger = load(includeInactive);

  const summaries = ledger.accounts.map(a => ({
    ...summarizeAccount(ledger, a, asOf, currency, options),
    institution: a.institution,
    is_active: a.is_active,
    mgmt_fee_balance_pct: a.mgmt_fee_balance_pct,
    mgmt_fee_deposit_pct: a.mgmt_fee_deposit_pct,
    notes: a.notes,
  }));

  ok(res, { as_of: asOf, display_currency: currency, accounts: summaries });
});

/** POST /api/accounts */
accountsRouter.post("/", (req, res) => {
  const db = getDb();
  const b = req.body as Record<string, unknown>;

  const row = {
    name: str(b, "name", { max: 120 }),
    institution: optStr(b, "institution", { max: 120 }),
    category: enumOf(b, "category", CATEGORIES),
    valuation_mode: enumOf(b, "valuation_mode", VALUATION_MODES),
    currency: enumOf(b, "currency", CURRENCIES),
    funding_mode: absent(b, "funding_mode") ? "manual" : enumOf(b, "funding_mode", FUNDING_MODES),
    mgmt_fee_balance_pct: optNum(b, "mgmt_fee_balance_pct", { min: 0, max: 100 }),
    mgmt_fee_deposit_pct: optNum(b, "mgmt_fee_deposit_pct", { min: 0, max: 100 }),
    is_active: bool(b, "is_active", true) ? 1 : 0,
    notes: optStr(b, "notes", { max: 2000 }),
  };

  const r = db.prepare(
    `INSERT INTO accounts (name, institution, category, valuation_mode, currency,
       funding_mode, mgmt_fee_balance_pct, mgmt_fee_deposit_pct, is_active, notes)
     VALUES (@name, @institution, @category, @valuation_mode, @currency,
       @funding_mode, @mgmt_fee_balance_pct, @mgmt_fee_deposit_pct, @is_active, @notes)`
  ).run(row);

  ok(res, getAccount(db, r.lastInsertRowid as number), 201);
});

/** GET /api/accounts/:id — summary + holdings + fee breakdown. */
accountsRouter.get("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const account = getAccount(db, id);
  if (!account) throw notFound("Account");

  const asOf = qDate(req, "as_of");
  const currency = requestCurrency(req, db);
  const ledger = load(true);
  const summary = summarizeAccount(ledger, account, asOf, currency, calcOptions(db));

  const holdings = db.prepare(`
    SELECT h.*,
           (SELECT p.price_minor FROM prices p
             WHERE p.holding_id = h.id AND p.date <= ? ORDER BY p.date DESC LIMIT 1) AS last_price_minor,
           (SELECT p.date FROM prices p
             WHERE p.holding_id = h.id AND p.date <= ? ORDER BY p.date DESC LIMIT 1) AS last_price_date,
           COALESCE((SELECT SUM(CASE WHEN t.type = 'buy' THEN t.quantity
                                     WHEN t.type = 'sell' THEN -t.quantity END)
                     FROM transactions t
                     WHERE t.holding_id = h.id AND t.date <= ?
                       AND t.type IN ('buy','sell')), 0) AS units
    FROM holdings h WHERE h.account_id = ? ORDER BY h.symbol
  `).all(asOf, asOf, asOf, id);

  ok(res, { account, summary, holdings });
});

/** PATCH /api/accounts/:id — sparse: only the keys present are touched. */
accountsRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = getAccount(db, id);
  if (!existing) throw notFound("Account");

  const b = req.body as Record<string, unknown>;
  const next: Partial<AccountRow> = {};

  if (!absent(b, "name")) next.name = str(b, "name", { max: 120 });
  if (!absent(b, "institution")) next.institution = optStr(b, "institution", { max: 120 });
  if (!absent(b, "category")) next.category = enumOf(b, "category", CATEGORIES);
  if (!absent(b, "valuation_mode")) next.valuation_mode = enumOf(b, "valuation_mode", VALUATION_MODES);
  if (!absent(b, "currency")) next.currency = enumOf(b, "currency", CURRENCIES);
  if (!absent(b, "funding_mode")) next.funding_mode = enumOf(b, "funding_mode", FUNDING_MODES);
  if (!absent(b, "mgmt_fee_balance_pct")) next.mgmt_fee_balance_pct = optNum(b, "mgmt_fee_balance_pct", { min: 0, max: 100 });
  if (!absent(b, "mgmt_fee_deposit_pct")) next.mgmt_fee_deposit_pct = optNum(b, "mgmt_fee_deposit_pct", { min: 0, max: 100 });
  if (!absent(b, "is_active")) next.is_active = bool(b, "is_active", true) ? 1 : 0;
  if (!absent(b, "notes")) next.notes = optStr(b, "notes", { max: 2000 });

  const keys = Object.keys(next);
  if (keys.length) {
    db.prepare(`UPDATE accounts SET ${keys.map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`)
      .run({ ...next, id });
  }
  ok(res, getAccount(db, id));
});

/** DELETE /api/accounts/:id — cascades to holdings, prices, transactions, RSUs. */
accountsRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = getAccount(db, id);
  if (!existing) throw notFound("Account");

  // Counted before deletion so the undo toast can say what actually went.
  const counts = {
    transactions: (db.prepare("SELECT COUNT(*) n FROM transactions WHERE account_id = ?").get(id) as { n: number }).n,
    holdings: (db.prepare("SELECT COUNT(*) n FROM holdings WHERE account_id = ?").get(id) as { n: number }).n,
    valuations: (db.prepare("SELECT COUNT(*) n FROM valuations WHERE account_id = ?").get(id) as { n: number }).n,
  };
  db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  ok(res, { deleted: existing, cascaded: counts });
});

/** GET /api/accounts/:id/series?range=3M|1Y|YTD|ALL */
accountsRouter.get("/:id/series", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const account = getAccount(db, id);
  if (!account) throw notFound("Account");

  const asOf = qDate(req, "as_of");
  const range = qEnum<Range>(req, "range", RANGES, "1Y");
  const currency = requestCurrency(req, db);
  const ledger = load(true);
  const dates = seriesDates(req, ledger, asOf);

  ok(res, {
    range, display_currency: currency,
    points: decomposeSeries(ledger, [account], dates, currency, calcOptions(db)),
  });
});

/**
 * GET /api/accounts/:id/projection?years=&annual_return_pct=
 *
 * This one account, compounded forward — in ITS OWN currency, because "what
 * will my hishtalmut be worth" is a question about the fund, not about the
 * exchange rate.
 */
accountsRouter.get("/:id/projection", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const account = getAccount(db, id);
  if (!account) throw notFound("Account");

  const asOf = qDate(req, "as_of");
  const q = projectionQuery(req);
  const ledger = load(true);
  const projected = projectAccount(db, ledger, account, q, calcOptions(db), asOf);
  if (!projected) {
    throw new HttpError("This account has no price or balance yet — nothing to project from", 409);
  }

  ok(res, {
    as_of: asOf,
    currency: account.currency,
    assumptions: {
      annual_return_pct: q.annualReturnPct,
      years: q.years,
      annual_balance_fee_pct: projected.input.annual_balance_fee_pct,
      deposit_fee_pct: projected.input.deposit_fee_pct,
      monthly_contribution_minor: projected.input.monthly_contribution_minor,
      start_value_minor: projected.input.start_value_minor,
      note: "A projection from your assumptions, not a forecast.",
    },
    points: projected.result.points,
    final: projected.result.final,
  });
});

// ── holdings ─────────────────────────────────────────────────────────────────

/** POST /api/accounts/:id/holdings */
accountsRouter.post("/:id/holdings", (req, res) => {
  const db = getDb();
  const accountId = intParam(req.params.id);
  const account = getAccount(db, accountId);
  if (!account) throw notFound("Account");

  const b = req.body as Record<string, unknown>;
  const row = {
    account_id: accountId,
    symbol: str(b, "symbol", { max: 24 }).toUpperCase(),
    display_name: optStr(b, "display_name", { max: 120 }),
    asset_class: enumOf(b, "asset_class", ASSET_CLASSES),
    currency: absent(b, "currency") ? account.currency : enumOf(b, "currency", CURRENCIES),
  };

  const r = db.prepare(
    `INSERT INTO holdings (account_id, symbol, display_name, asset_class, currency)
     VALUES (@account_id, @symbol, @display_name, @asset_class, @currency)`
  ).run(row);

  ok(res, db.prepare("SELECT * FROM holdings WHERE id = ?").get(r.lastInsertRowid), 201);
});

export const holdingsRouter = Router();
holdingsRouter.use(requireAuth);

/**
 * GET /api/holdings — every holding in one call, with its latest price.
 * The quick-add sheet needs the whole list to build its picker; asking for it
 * account-by-account would be a request per account on every open.
 */
holdingsRouter.get("/", (req, res) => {
  const db = getDb();
  const asOf = qDate(req, "as_of");
  const holdings = db.prepare(`
    SELECT h.*, a.name AS account_name, a.category AS account_category,
           (SELECT p.price_minor FROM prices p
             WHERE p.holding_id = h.id AND p.date <= ? ORDER BY p.date DESC LIMIT 1) AS last_price_minor,
           (SELECT p.date FROM prices p
             WHERE p.holding_id = h.id AND p.date <= ? ORDER BY p.date DESC LIMIT 1) AS last_price_date
    FROM holdings h JOIN accounts a ON a.id = h.account_id
    WHERE a.is_active = 1
    ORDER BY a.name, h.symbol
  `).all(asOf, asOf);
  ok(res, { holdings });
});

holdingsRouter.patch("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM holdings WHERE id = ?").get(id);
  if (!existing) throw notFound("Holding");

  const b = req.body as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  if (!absent(b, "symbol")) next.symbol = str(b, "symbol", { max: 24 }).toUpperCase();
  if (!absent(b, "display_name")) next.display_name = optStr(b, "display_name", { max: 120 });
  if (!absent(b, "asset_class")) next.asset_class = enumOf(b, "asset_class", ASSET_CLASSES);
  if (!absent(b, "currency")) next.currency = enumOf(b, "currency", CURRENCIES);

  const keys = Object.keys(next);
  if (keys.length) {
    db.prepare(`UPDATE holdings SET ${keys.map(k => `${k} = @${k}`).join(", ")} WHERE id = @id`)
      .run({ ...next, id });
  }
  ok(res, db.prepare("SELECT * FROM holdings WHERE id = ?").get(id));
});

holdingsRouter.delete("/:id", (req, res) => {
  const db = getDb();
  const id = intParam(req.params.id);
  const existing = db.prepare("SELECT * FROM holdings WHERE id = ?").get(id);
  if (!existing) throw notFound("Holding");
  db.prepare("DELETE FROM holdings WHERE id = ?").run(id);
  ok(res, { deleted: existing });
});
