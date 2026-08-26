import { Router } from "express";
import { getDb } from "../db/init.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../middleware/respond.js";
import {
  valueAccount, loadAccounts, today,
  type AccountRow, type Currency,
} from "../services/valuation.js";
import { recomputeAccruals } from "../services/fees.js";
import {
  date, nonEmpty, oneOf, optionalPct, symbol as normSymbol, isErr,
  ACCOUNT_KINDS, VALUATION_MODES, FUNDING_MODES, CURRENCIES,
} from "./validate.js";

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

function displayCcy(req: { user?: { display_currency?: string } }): Currency {
  return (req.user?.display_currency === "USD" ? "USD" : "ILS");
}

function load(db: ReturnType<typeof getDb>, id: number, userId: number): AccountRow | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ? AND user_id = ?")
    .get(id, userId) as AccountRow | undefined;
}

// GET /api/accounts?as_of=YYYY-MM-DD — every account, valued and decomposed
accountsRouter.get("/", (req, res) => {
  try {
    const db = getDb();
    const asOf = req.query.as_of ? String(req.query.as_of).slice(0, 10) : today();
    const ccy = req.query.currency ? String(req.query.currency) as Currency : displayCcy(req);
    const rows = loadAccounts(db, req.user!.id, req.query.include_archived === "true");
    ok(res, rows.map(a => valueAccount(db, a, ccy, asOf)));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/accounts/:id — one account with its ledger
accountsRouter.get("/:id", (req, res) => {
  try {
    const db = getDb();
    const account = load(db, Number(req.params.id), req.user!.id);
    if (!account) return fail(res, "Account not found", 404);

    const asOf = req.query.as_of ? String(req.query.as_of).slice(0, 10) : today();
    const ccy = req.query.currency ? String(req.query.currency) as Currency : displayCcy(req);

    const entries = db.prepare(
      `SELECT * FROM entries WHERE account_id = ?
       ORDER BY occurred_on DESC, id DESC LIMIT 500`
    ).all(account.id);

    const rules = db.prepare(
      "SELECT * FROM deposit_rules WHERE account_id = ? ORDER BY id"
    ).all(account.id);

    ok(res, {
      account,
      valuation: valueAccount(db, account, ccy, asOf),
      entries,
      rules,
    });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// POST /api/accounts
accountsRouter.post("/", (req, res) => {
  try {
    const db = getDb();
    const b = req.body as Record<string, unknown>;

    const name = nonEmpty(b.name, "name");
    if (isErr(name)) return fail(res, name.error);
    const kind = oneOf(b.kind, ACCOUNT_KINDS, "kind");
    if (isErr(kind)) return fail(res, kind.error);
    const mode = oneOf(b.valuation_mode, VALUATION_MODES, "valuation_mode");
    if (isErr(mode)) return fail(res, mode.error);
    const funding = oneOf(b.funding_mode ?? "manual", FUNDING_MODES, "funding_mode");
    if (isErr(funding)) return fail(res, funding.error);
    const ccy = oneOf(b.currency ?? "ILS", CURRENCIES, "currency");
    if (isErr(ccy)) return fail(res, ccy.error);

    const sym = normSymbol(b.symbol);
    if (mode.value === "market" && !sym) {
      return fail(res, "A market-priced account needs a symbol to hang its prices on");
    }

    const depFee = optionalPct(b.fee_deposit_pct, "fee_deposit_pct", 100);
    if (isErr(depFee)) return fail(res, depFee.error);
    const balFee = optionalPct(b.fee_balance_annual_pct, "fee_balance_annual_pct", 20);
    if (isErr(balFee)) return fail(res, balFee.error);

    const id = db.prepare(
      `INSERT INTO accounts (user_id, name, kind, valuation_mode, funding_mode, currency,
                             symbol, fee_deposit_pct, fee_balance_annual_pct, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user!.id, name.value, kind.value, mode.value, funding.value, ccy.value,
      mode.value === "market" ? sym : null,
      depFee.value, balFee.value,
      typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null
    ).lastInsertRowid as number;

    const account = load(db, id, req.user!.id)!;
    ok(res, valueAccount(db, account, displayCcy(req), today()), 201);
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// PATCH /api/accounts/:id — partial: only the fields sent are touched
accountsRouter.patch("/:id", (req, res) => {
  try {
    const db = getDb();
    const account = load(db, Number(req.params.id), req.user!.id);
    if (!account) return fail(res, "Account not found", 404);

    const b = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];

    if ("name" in b) {
      const r = nonEmpty(b.name, "name");
      if (isErr(r)) return fail(res, r.error);
      sets.push("name = ?"); vals.push(r.value);
    }
    if ("funding_mode" in b) {
      const r = oneOf(b.funding_mode, FUNDING_MODES, "funding_mode");
      if (isErr(r)) return fail(res, r.error);
      sets.push("funding_mode = ?"); vals.push(r.value);
    }
    if ("symbol" in b) {
      const sym = normSymbol(b.symbol);
      if (account.valuation_mode === "market" && !sym) {
        return fail(res, "A market-priced account needs a symbol");
      }
      sets.push("symbol = ?"); vals.push(sym);
    }
    if ("fee_deposit_pct" in b) {
      const r = optionalPct(b.fee_deposit_pct, "fee_deposit_pct", 100);
      if (isErr(r)) return fail(res, r.error);
      sets.push("fee_deposit_pct = ?"); vals.push(r.value);
    }
    if ("fee_balance_annual_pct" in b) {
      const r = optionalPct(b.fee_balance_annual_pct, "fee_balance_annual_pct", 20);
      if (isErr(r)) return fail(res, r.error);
      sets.push("fee_balance_annual_pct = ?"); vals.push(r.value);
    }
    if ("notes" in b) {
      sets.push("notes = ?");
      vals.push(typeof b.notes === "string" && b.notes.trim() ? b.notes.trim() : null);
    }
    if ("archived_at" in b) {
      sets.push("archived_at = ?");
      vals.push(b.archived_at ? new Date().toISOString() : null);
    }
    if (sets.length === 0) return fail(res, "No valid fields to update");

    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    vals.push(account.id);
    db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

    // Fee rates may have changed — regenerate estimates from the new rates.
    const updated = load(db, account.id, req.user!.id)!;
    recomputeAccruals(db, updated);
    ok(res, valueAccount(db, updated, displayCcy(req), today()));
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// DELETE /api/accounts/:id — removes the account and its whole ledger
accountsRouter.delete("/:id", (req, res) => {
  try {
    const db = getDb();
    const account = load(db, Number(req.params.id), req.user!.id);
    if (!account) return fail(res, "Account not found", 404);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);
    ok(res, { id: account.id });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// GET /api/accounts/:id/history?from=&to= — decomposition over time for charting
accountsRouter.get("/:id/history", (req, res) => {
  try {
    const db = getDb();
    const account = load(db, Number(req.params.id), req.user!.id);
    if (!account) return fail(res, "Account not found", 404);

    const ccy = displayCcy(req);
    const to = req.query.to ? String(req.query.to).slice(0, 10) : today();
    const firstRow = db.prepare(
      "SELECT MIN(occurred_on) AS first FROM entries WHERE account_id = ?"
    ).get(account.id) as { first: string | null };
    const from = req.query.from ? String(req.query.from).slice(0, 10) : (firstRow.first ?? to);

    const points = monthlySeries(from, to, (d: string) =>
      pickDecomposition(valueAccount(db, account, ccy, d)));
    ok(res, { account_id: account.id, points });
  } catch (e) {
    fail(res, (e as Error).message, 500);
  }
});

// ── Shared history helpers ────────────────────────────────────────────────────

export interface DecompositionPoint {
  on: string;
  value: number;
  principal: number;
  gross_earnings: number;
  fees: number;
}

export function pickDecomposition(v: {
  value_display: number; principal_display: number;
  gross_earnings_display: number; fees_display: number;
}): Omit<DecompositionPoint, "on"> {
  return {
    value: v.value_display,
    principal: v.principal_display,
    gross_earnings: v.gross_earnings_display,
    fees: v.fees_display,
  };
}

/**
 * Month-end samples from `from` to `to`, plus `to` itself. Valuation is a pure
 * point-in-time query, so the series is just the same call at several dates —
 * no stored history required, and it stays correct when you back-date an entry.
 */
export function monthlySeries<T>(
  from: string, to: string, at: (date: string) => T
): (T & { on: string })[] {
  const out: (T & { on: string })[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));

  let guard = 0;
  while ((y < endY || (y === endY && m < endM)) && guard++ < 600) {
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push({ on: monthEnd, ...at(monthEnd) });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  out.push({ on: to, ...at(to) });
  return out;
}
