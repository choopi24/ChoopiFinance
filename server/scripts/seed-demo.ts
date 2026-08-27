/**
 * npm run seed:demo — realistic demo data covering every modelled case.
 *
 * Wipes the financial tables (NOT users/settings) and inserts:
 *   • 2 × keren hishtalmut  — one salary-funded with employee+employer splits,
 *                             one passive/frozen from a previous employer
 *   • 1 × pension           — employee / employer / severance splits + both fees
 *   • 1 × gemel lehashkaa   — manual deposits, balance fee only
 *   • 1 × brokerage (USD)   — a stock + an ETF, with trades and trade fees
 *   • 1 × crypto (USD)      — fractional units
 *   • 1 × RSU grant         — 1-year cliff, quarterly vesting over 4 years
 *   • ~7 months of prices, balance snapshots and USD→ILS FX rates
 *
 * All money is INTEGER minor units (agorot / cents). All dates are YYYY-MM-DD.
 */

import { getDb, closeDb } from "../src/db/init.js";

const db = getDb();

// ── helpers ──────────────────────────────────────────────────────────────────

/** ₪1,234.56 → 123456 agorot. Rounded, never floated into storage. */
const minor = (major: number): number => Math.round(major * 100);

/** Month-ends we use for the price / balance / FX series. */
const MONTHS = [
  "2026-01-31", "2026-02-28", "2026-03-31",
  "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
];

function account(a: {
  name: string; institution?: string; category: string;
  valuation_mode: "market" | "balance"; currency: "ILS" | "USD";
  funding_mode?: "manual" | "salary" | "passive";
  mgmt_fee_balance_pct?: number | null; mgmt_fee_deposit_pct?: number | null;
  is_active?: 0 | 1; notes?: string;
}): number {
  return db.prepare(
    `INSERT INTO accounts (name, institution, category, valuation_mode, currency,
                           funding_mode, mgmt_fee_balance_pct, mgmt_fee_deposit_pct,
                           is_active, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    a.name, a.institution ?? null, a.category, a.valuation_mode, a.currency,
    a.funding_mode ?? "manual", a.mgmt_fee_balance_pct ?? null,
    a.mgmt_fee_deposit_pct ?? null, a.is_active ?? 1, a.notes ?? null
  ).lastInsertRowid as number;
}

function holding(h: {
  account_id: number; symbol: string; display_name: string;
  asset_class: "stock" | "etf" | "crypto"; currency: "ILS" | "USD";
}): number {
  return db.prepare(
    `INSERT INTO holdings (account_id, symbol, display_name, asset_class, currency)
     VALUES (?, ?, ?, ?, ?)`
  ).run(h.account_id, h.symbol, h.display_name, h.asset_class, h.currency)
   .lastInsertRowid as number;
}

const insPrice = db.prepare(
  "INSERT INTO prices (holding_id, date, price_minor, currency) VALUES (?, ?, ?, ?)"
);
const insValuation = db.prepare(
  "INSERT INTO valuations (account_id, date, balance_minor, currency) VALUES (?, ?, ?, ?)"
);
const insFx = db.prepare(
  "INSERT INTO fx_rates (date, base_currency, quote_currency, rate) VALUES (?, 'USD', 'ILS', ?)"
);
const insTx = db.prepare(
  `INSERT INTO transactions (account_id, holding_id, date, type, amount_minor, quantity,
                             price_minor, contribution_part, fee_kind, currency, source,
                             recurring_rule_id, note)
   VALUES (@account_id, @holding_id, @date, @type, @amount_minor, @quantity,
           @price_minor, @contribution_part, @fee_kind, @currency, @source,
           @recurring_rule_id, @note)`
);

type TxInput = {
  account_id: number; date: string; type: string; amount_minor: number;
  currency: "ILS" | "USD"; holding_id?: number | null; quantity?: number | null;
  price_minor?: number | null; contribution_part?: string | null;
  fee_kind?: string | null; source?: "manual" | "recurring";
  recurring_rule_id?: number | null; note?: string | null;
};

function tx(t: TxInput): void {
  insTx.run({
    holding_id: null, quantity: null, price_minor: null, contribution_part: null,
    fee_kind: null, source: "manual", recurring_rule_id: null, note: null, ...t,
  });
}

function rule(r: {
  account_id: number; label: string; day_of_month: number; amount_minor: number;
  currency: "ILS" | "USD"; contribution_part?: string | null; start_date: string;
}): number {
  return db.prepare(
    `INSERT INTO recurring_rules (account_id, label, frequency, day_of_month,
                                  amount_minor, currency, contribution_part,
                                  start_date, auto_generate, last_generated_date)
     VALUES (?, ?, 'monthly', ?, ?, ?, ?, ?, 1, ?)`
  ).run(r.account_id, r.label, r.day_of_month, r.amount_minor, r.currency,
        r.contribution_part ?? null, r.start_date, MONTHS[MONTHS.length - 1])
   .lastInsertRowid as number;
}

/** Post a rule's monthly deposit for each month, plus its deposit fee if any. */
function postMonthly(
  accountId: number, ruleId: number, day: number, amountMinor: number,
  part: string | null, depositFeePct: number | null, currency: "ILS" | "USD"
): void {
  for (const monthEnd of MONTHS) {
    const date = `${monthEnd.slice(0, 7)}-${String(day).padStart(2, "0")}`;
    tx({
      account_id: accountId, date, type: "deposit", amount_minor: amountMinor,
      contribution_part: part, currency, source: "recurring",
      recurring_rule_id: ruleId, note: "Monthly salary contribution",
    });
    if (depositFeePct && depositFeePct > 0) {
      tx({
        account_id: accountId, date, type: "fee",
        amount_minor: -Math.round(amountMinor * depositFeePct / 100),
        fee_kind: "management_deposit", currency,
        note: `${depositFeePct}% deposit fee`,
      });
    }
  }
}

/**
 * An account that existed before tracking began needs its accumulated
 * contributions recorded, otherwise `value − deposits` reports the whole
 * pre-existing balance as profit. One dated deposit before the window is the
 * honest representation of "money I had already put in".
 */
function openingBalance(
  accountId: number, date: string, amountMinor: number, currency: "ILS" | "USD"
): void {
  tx({
    account_id: accountId, date, type: "deposit", amount_minor: amountMinor,
    currency, note: "Opening balance — contributions made before tracking started",
  });
}

/** Monthly balance-fee charges derived from an annual percentage. */
function postBalanceFees(
  accountId: number, balancesMinor: number[], annualPct: number, currency: "ILS" | "USD"
): void {
  MONTHS.forEach((monthEnd, i) => {
    const fee = Math.round(balancesMinor[i] * (annualPct / 100 / 12));
    if (fee > 0) {
      tx({
        account_id: accountId, date: monthEnd, type: "fee", amount_minor: -fee,
        fee_kind: "management_balance", currency,
        note: `${annualPct}%/yr balance fee`,
      });
    }
  });
}

// ── wipe (financial tables only; login + settings survive) ───────────────────

const wipe = db.transaction(() => {
  for (const t of ["rsu_vests", "rsu_grants", "transactions", "valuations",
                   "prices", "holdings", "recurring_rules", "fx_rates", "accounts"]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name IN " +
    "('rsu_vests','rsu_grants','transactions','valuations','prices','holdings'," +
    "'recurring_rules','fx_rates','accounts')").run();
});
wipe();

// ── seed ─────────────────────────────────────────────────────────────────────

const seed = db.transaction(() => {
  // FX: USD→ILS drifting through the period.
  const fxRates = [3.62, 3.66, 3.71, 3.68, 3.74, 3.70, 3.67];
  MONTHS.forEach((d, i) => insFx.run(d, fxRates[i]));

  // ══ 1. Keren Hishtalmut — active, salary-funded, employee + employer ══
  const kh1 = account({
    name: "Keren Hishtalmut — Altshuler Shaham", institution: "Altshuler Shaham",
    category: "keren_hishtalmut", valuation_mode: "balance", currency: "ILS",
    funding_mode: "salary", mgmt_fee_balance_pct: 0.62, mgmt_fee_deposit_pct: 0,
    notes: "Track: general. Liquid from 2029.",
  });
  const kh1Employee = rule({
    account_id: kh1, label: "Employee 2.5%", day_of_month: 9,
    amount_minor: minor(1_050), currency: "ILS", contribution_part: "employee",
    start_date: "2026-01-01",
  });
  const kh1Employer = rule({
    account_id: kh1, label: "Employer 7.5%", day_of_month: 9,
    amount_minor: minor(3_150), currency: "ILS", contribution_part: "employer",
    start_date: "2026-01-01",
  });
  openingBalance(kh1, "2025-12-31", minor(168_000), "ILS");
  postMonthly(kh1, kh1Employee, 9, minor(1_050), "employee", 0, "ILS");
  postMonthly(kh1, kh1Employer, 9, minor(3_150), "employer", 0, "ILS");
  const kh1Balances = [186_400, 191_900, 196_200, 202_800, 208_100, 212_400, 218_900]
    .map(minor);
  MONTHS.forEach((d, i) => insValuation.run(kh1, d, kh1Balances[i], "ILS"));
  postBalanceFees(kh1, kh1Balances, 0.62, "ILS");

  // ══ 2. Keren Hishtalmut — frozen from a previous employer (passive) ══
  const kh2 = account({
    name: "Keren Hishtalmut — Menora (old employer)", institution: "Menora Mivtachim",
    category: "keren_hishtalmut", valuation_mode: "balance", currency: "ILS",
    funding_mode: "passive", mgmt_fee_balance_pct: 0.85,
    notes: "No new deposits since leaving in 2024. Higher fee — consider moving.",
  });
  openingBalance(kh2, "2025-12-31", minor(68_000), "ILS");
  const kh2Balances = [74_200, 75_100, 74_800, 76_300, 77_900, 78_400, 79_600].map(minor);
  MONTHS.forEach((d, i) => insValuation.run(kh2, d, kh2Balances[i], "ILS"));
  postBalanceFees(kh2, kh2Balances, 0.85, "ILS");

  // ══ 3. Pension — employee / employer / severance, both fee types ══
  const pension = account({
    name: "Pension — Menora Mivtachim", institution: "Menora Mivtachim",
    category: "pension", valuation_mode: "balance", currency: "ILS",
    funding_mode: "salary", mgmt_fee_balance_pct: 0.22, mgmt_fee_deposit_pct: 1.49,
    notes: "Comprehensive pension. Employee 6%, employer 6.5%, severance 8.33%.",
  });
  openingBalance(pension, "2025-12-31", minor(400_000), "ILS");
  const parts: { part: string; label: string; major: number }[] = [
    { part: "employee",  label: "Employee 6%",     major: 2_520 },
    { part: "employer",  label: "Employer 6.5%",   major: 2_730 },
    { part: "severance", label: "Severance 8.33%", major: 3_499 },
  ];
  for (const p of parts) {
    const rid = rule({
      account_id: pension, label: p.label, day_of_month: 9,
      amount_minor: minor(p.major), currency: "ILS",
      contribution_part: p.part, start_date: "2026-01-01",
    });
    postMonthly(pension, rid, 9, minor(p.major), p.part, 1.49, "ILS");
  }
  const pensionBalances = [
    438_000, 449_500, 458_900, 471_200, 480_600, 492_300, 505_700,
  ].map(minor);
  MONTHS.forEach((d, i) => insValuation.run(pension, d, pensionBalances[i], "ILS"));
  postBalanceFees(pension, pensionBalances, 0.22, "ILS");

  // ══ 4. Gemel Lehashkaa — manual ad-hoc deposits ══
  const gemel = account({
    name: "Gemel Lehashkaa — Phoenix", institution: "The Phoenix",
    category: "gemel_lehashkaa", valuation_mode: "balance", currency: "ILS",
    funding_mode: "manual", mgmt_fee_balance_pct: 0.70,
    notes: "Annual ceiling ~₪79k. Deposit when there's spare cash.",
  });
  openingBalance(gemel, "2025-12-31", minor(58_000), "ILS");
  tx({ account_id: gemel, date: "2026-02-15", type: "deposit",
       amount_minor: minor(20_000), currency: "ILS", note: "Bonus" });
  tx({ account_id: gemel, date: "2026-05-20", type: "deposit",
       amount_minor: minor(15_000), currency: "ILS", note: "Savings transfer" });
  tx({ account_id: gemel, date: "2026-06-10", type: "withdrawal",
       amount_minor: -minor(5_000), currency: "ILS", note: "Needed cash" });
  const gemelBalances = [61_200, 81_800, 82_600, 83_100, 98_700, 94_400, 96_100].map(minor);
  MONTHS.forEach((d, i) => insValuation.run(gemel, d, gemelBalances[i], "ILS"));
  postBalanceFees(gemel, gemelBalances, 0.70, "ILS");

  // ══ 5. Brokerage (USD) — a stock and an ETF, market-valued ══
  const broker = account({
    name: "Interactive Brokers", institution: "IBKR",
    category: "etf", valuation_mode: "market", currency: "USD",
    funding_mode: "manual", notes: "Taxable brokerage.",
  });
  const voo = holding({ account_id: broker, symbol: "VOO",
    display_name: "Vanguard S&P 500 ETF", asset_class: "etf", currency: "USD" });
  const msft = holding({ account_id: broker, symbol: "MSFT",
    display_name: "Microsoft Corp", asset_class: "stock", currency: "USD" });

  // Market accounts hold CASH too: you deposit, then a buy converts cash into
  // units. So `deposit` is still the single source of principal, and the
  // account's value is units × price PLUS whatever cash is left over.
  tx({ account_id: broker, date: "2026-01-10", type: "deposit",
       amount_minor: minor(12_000), currency: "USD", note: "Wire from bank" });

  // Trades: cash out is negative, and each carries its trade fee.
  tx({ account_id: broker, holding_id: voo, date: "2026-01-15", type: "buy",
       quantity: 12, price_minor: minor(482.10), amount_minor: -minor(12 * 482.10),
       currency: "USD", note: "Initial position" });
  tx({ account_id: broker, date: "2026-01-15", type: "fee", amount_minor: -minor(1.00),
       fee_kind: "trade", currency: "USD", note: "Commission" });
  tx({ account_id: broker, holding_id: voo, date: "2026-04-10", type: "buy",
       quantity: 5, price_minor: minor(511.40), amount_minor: -minor(5 * 511.40),
       currency: "USD", note: "Top-up" });
  tx({ account_id: broker, date: "2026-04-10", type: "fee", amount_minor: -minor(1.00),
       fee_kind: "trade", currency: "USD" });
  tx({ account_id: broker, holding_id: msft, date: "2026-02-03", type: "buy",
       quantity: 8, price_minor: minor(408.75), amount_minor: -minor(8 * 408.75),
       currency: "USD" });
  tx({ account_id: broker, holding_id: msft, date: "2026-06-18", type: "sell",
       quantity: 3, price_minor: minor(455.20), amount_minor: minor(3 * 455.20),
       currency: "USD", note: "Trimmed" });
  tx({ account_id: broker, date: "2026-03-20", type: "dividend",
       amount_minor: minor(18.42), currency: "USD", note: "VOO Q1 distribution" });
  tx({ account_id: broker, date: "2026-06-20", type: "dividend",
       amount_minor: minor(21.05), currency: "USD", note: "VOO Q2 distribution" });

  const vooPrices  = [485.20, 492.60, 505.10, 511.40, 498.30, 519.75, 528.40];
  const msftPrices = [401.10, 408.75, 425.30, 431.90, 442.15, 455.20, 468.60];
  MONTHS.forEach((d, i) => {
    insPrice.run(voo,  d, minor(vooPrices[i]),  "USD");
    insPrice.run(msft, d, minor(msftPrices[i]), "USD");
  });

  // ══ 6. Crypto (USD) — fractional units ══
  const crypto = account({
    name: "Kraken", institution: "Kraken",
    category: "crypto", valuation_mode: "market", currency: "USD",
    funding_mode: "manual", notes: "Long-term hold.",
  });
  const btc = holding({ account_id: crypto, symbol: "BTC",
    display_name: "Bitcoin", asset_class: "crypto", currency: "USD" });
  tx({ account_id: crypto, date: "2026-01-18", type: "deposit",
       amount_minor: minor(11_500), currency: "USD", note: "Funding transfer" });
  tx({ account_id: crypto, holding_id: btc, date: "2026-01-20", type: "buy",
       quantity: 0.085, price_minor: minor(94_200), amount_minor: -minor(0.085 * 94_200),
       currency: "USD", note: "DCA" });
  tx({ account_id: crypto, holding_id: btc, date: "2026-05-05", type: "buy",
       quantity: 0.032, price_minor: minor(101_500), amount_minor: -minor(0.032 * 101_500),
       currency: "USD", note: "DCA" });
  const btcPrices = [95_100, 92_400, 99_800, 104_200, 101_500, 108_900, 112_300];
  MONTHS.forEach((d, i) => insPrice.run(btc, d, minor(btcPrices[i]), "USD"));

  // ══ 7. RSU — 1-year cliff, quarterly vesting over 4 years ══
  const rsuAccount = account({
    name: "ACME Corp RSUs", institution: "E*TRADE",
    category: "rsu", valuation_mode: "market", currency: "USD",
    funding_mode: "passive", notes: "Section 102 trustee track.",
  });
  const acme = holding({ account_id: rsuAccount, symbol: "ACME",
    display_name: "ACME Corp", asset_class: "stock", currency: "USD" });
  const acmePrices = [58.40, 61.20, 59.80, 64.50, 67.10, 71.30, 74.80];
  MONTHS.forEach((d, i) => insPrice.run(acme, d, minor(acmePrices[i]), "USD"));

  const grantId = db.prepare(
    `INSERT INTO rsu_grants (account_id, symbol, grant_date, total_units,
                             grant_price_minor, currency, cliff_months,
                             vest_duration_months, vest_frequency, notes)
     VALUES (?, 'ACME', '2025-04-01', 1600, ?, 'USD', 12, 48, 'quarterly', ?)`
  ).run(rsuAccount, minor(52.00),
        "1-year cliff (25%), then quarterly over the remaining 3 years")
   .lastInsertRowid as number;

  // Quarterly schedule: the 12-month cliff releases the first 4 quarters at
  // once (400 units), then 100 units every quarter to month 48.
  const insVest = db.prepare(
    `INSERT INTO rsu_vests (grant_id, vest_date, units, price_at_vest_minor,
                            units_sold_to_cover_tax, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const TODAY = "2026-08-27";
  /** grant_date + n months, clamped to the month's length. */
  function addMonths(iso: string, months: number): string {
    const [y, m, d] = iso.split("-").map(Number);
    const t = m - 1 + months;
    const ty = y + Math.floor(t / 12);
    const tm = ((t % 12) + 12) % 12;
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  }
  // Vest prices for tranches that have already happened (manually recorded).
  const vestedPrices: Record<string, number> = {
    "2026-04-01": 63.20,   // cliff
    "2026-07-01": 70.10,
  };
  for (let month = 12; month <= 48; month += 3) {
    const vestDate = addMonths("2025-04-01", month);
    const units = month === 12 ? 400 : 100;
    const isPast = vestDate <= TODAY;
    const priceMajor = vestedPrices[vestDate];
    insVest.run(
      grantId, vestDate, units,
      isPast && priceMajor != null ? minor(priceMajor) : null,
      // Israeli 102 trustee track: shares sold at vest to cover withholding.
      isPast ? Math.round(units * 0.35) : 0,
      isPast ? "vested" : "scheduled"
    );
    // NOTE: no transactions are written for a vest. The calculation layer rolls
    // vested units (net of shares sold for tax) into the linked holding straight
    // from rsu_vests — see calc/engine.unitsHeldOn. Writing a buy here as well
    // would count the same shares twice. Principal follows the
    // rsu_principal_at_vest_price setting: zero cost by default.
  }
});
seed();

// ── report ───────────────────────────────────────────────────────────────────

const counts = ["accounts", "holdings", "prices", "transactions", "valuations",
                "recurring_rules", "fx_rates", "rsu_grants", "rsu_vests"]
  .map(t => `${t}=${(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n}`);

console.log("\n✓ Demo data seeded\n  " + counts.join("  "));

const fkIssues = db.pragma("foreign_key_check") as unknown[];
console.log(`  foreign_key_check: ${fkIssues.length === 0 ? "clean" : JSON.stringify(fkIssues)}`);

const byAccount = db.prepare(`
  SELECT a.name, a.category, a.valuation_mode, a.currency,
         COALESCE((SELECT SUM(amount_minor) FROM transactions t
                   WHERE t.account_id = a.id AND t.type IN ('deposit','withdrawal')), 0) AS net_deposits_minor,
         COALESCE((SELECT -SUM(amount_minor) FROM transactions t
                   WHERE t.account_id = a.id AND t.type = 'fee'), 0) AS fees_minor
  FROM accounts a ORDER BY a.id
`).all() as { name: string; category: string; valuation_mode: string; currency: string;
              net_deposits_minor: number; fees_minor: number }[];

console.log("\n  account                                     mode      net deposits      fees");
console.log("  " + "─".repeat(78));
for (const r of byAccount) {
  const cur = r.currency === "USD" ? "$" : "₪";
  console.log(
    `  ${r.name.slice(0, 42).padEnd(42)} ${r.valuation_mode.padEnd(8)} ` +
    `${(cur + (r.net_deposits_minor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })).padStart(14)} ` +
    `${(cur + (r.fees_minor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })).padStart(9)}`
  );
}
console.log("");

closeDb();
