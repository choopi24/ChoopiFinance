/**
 * Israeli regulated funds — Gemel-Net & Pensia-Net via data.gov.il (free, no key).
 *
 *   gemel  → קופות גמל + קרנות השתלמות   (Gemel-Net dataset)
 *   pensia → קרנות פנסיה חדשות            (Pensia-Net dataset, 2024–today)
 *
 * These funds have no live market price. The regulator publishes, per fund
 * track (מסלול), a MONTHLY_YIELD (percent, gross of personal management fees)
 * with ~1–2 months lag. We cache those rows in il_fund_cache and use them to
 * grow the user's last manually-entered balance forward:
 *
 *   for each month since the last balance snapshot:
 *     V = V × (1 + monthly_yield/100)          — published track yield
 *     V = V × (1 − fee_balance_pct/100/12)     — personal דמי ניהול מצבירה
 *     V = V + monthly_deposit × (1 − fee_deposit_pct/100)  — net contribution
 *
 * Months with no published yield yet contribute deposits only. The result is
 * an *estimate* — the user's manual balance updates remain the source of truth
 * and reset the baseline.
 *
 * Money-market funds (קרנות כספיות) are ISA mutual funds, not covered by these
 * datasets — they stay fully manual.
 */

import type Database from "better-sqlite3";

export type IlDataset = "gemel" | "pensia";

const RESOURCE_IDS: Record<IlDataset, string> = {
  gemel:  "a30dcbea-a1d2-482c-ae29-8f781f5025fb", // Gemel-Net
  pensia: "6d47d6b5-cb08-488b-b333-f1e717b1e1bd", // Pensia-Net 2024–today
};

const DATASTORE_URL = "https://data.gov.il/api/3/action/datastore_search";
const FETCH_TTL_MS = 24 * 60 * 60 * 1_000; // regulator data is monthly; refresh daily

/** Which regulator dataset covers an investment type (null = not covered). */
export function datasetForType(type: string): IlDataset | null {
  if (type === "pension") return "pensia";
  if (type === "gemel" || type === "education") return "gemel";
  return null;
}

// ── Raw dataset row (fields shared by both datasets) ──────────────────────────

interface DatastoreRecord {
  FUND_ID: number;
  FUND_NAME: string;
  FUND_CLASSIFICATION?: string;
  MANAGING_CORPORATION?: string;
  REPORT_PERIOD: number; // YYYYMM
  MONTHLY_YIELD?: number | null;
  YEAR_TO_DATE_YIELD?: number | null;
  AVG_ANNUAL_MANAGEMENT_FEE?: number | null;
  AVG_DEPOSIT_FEE?: number | null;
  AVG_ANNUAL_YIELD_TRAILING_5YRS?: number | null;
}

async function queryDatastore(
  dataset: IlDataset,
  params: Record<string, string>,
  fetchImpl: typeof fetch
): Promise<DatastoreRecord[]> {
  const qs = new URLSearchParams({ resource_id: RESOURCE_IDS[dataset], ...params });
  const resp = await fetchImpl(`${DATASTORE_URL}?${qs}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`data.gov.il HTTP ${resp.status}`);
  const json = await resp.json() as { success?: boolean; result?: { records?: DatastoreRecord[] } };
  if (!json.success || !json.result?.records) throw new Error("Unexpected data.gov.il response");
  return json.result.records;
}

// ── Search funds by (Hebrew) name ─────────────────────────────────────────────

export interface IlFundHit {
  fund_id: number;
  name: string;
  classification: string | null;
  managing_corporation: string | null;
  latest_period: number;
  monthly_yield: number | null;
  year_to_date_yield: number | null;
  avg_annual_yield_5yrs: number | null;
  /** Official average fees reported by the fund (percent). */
  avg_annual_mgmt_fee: number | null;
  avg_deposit_fee: number | null;
}

/**
 * Full-text search over a regulator dataset, deduplicated to the latest
 * REPORT_PERIOD per fund. Fails soft is the caller's job (route returns []).
 */
export async function searchIlFunds(
  dataset: IlDataset,
  q: string,
  fetchImpl: typeof fetch = fetch
): Promise<IlFundHit[]> {
  const records = await queryDatastore(dataset, { q, limit: "200" }, fetchImpl);

  const byFund = new Map<number, DatastoreRecord>();
  for (const r of records) {
    if (r.FUND_ID == null || !r.REPORT_PERIOD) continue;
    const cur = byFund.get(r.FUND_ID);
    if (!cur || r.REPORT_PERIOD > cur.REPORT_PERIOD) byFund.set(r.FUND_ID, r);
  }

  return [...byFund.values()]
    .map(r => ({
      fund_id: r.FUND_ID,
      name: r.FUND_NAME,
      classification: r.FUND_CLASSIFICATION ?? null,
      managing_corporation: r.MANAGING_CORPORATION ?? null,
      latest_period: r.REPORT_PERIOD,
      monthly_yield: r.MONTHLY_YIELD ?? null,
      year_to_date_yield: r.YEAR_TO_DATE_YIELD ?? null,
      avg_annual_yield_5yrs: r.AVG_ANNUAL_YIELD_TRAILING_5YRS ?? null,
      avg_annual_mgmt_fee: r.AVG_ANNUAL_MANAGEMENT_FEE ?? null,
      avg_deposit_fee: r.AVG_DEPOSIT_FEE ?? null,
    }))
    .sort((a, b) => b.latest_period - a.latest_period || a.name.localeCompare(b.name))
    .slice(0, 12);
}

// ── Refresh cached monthly yields for one fund ───────────────────────────────

/**
 * Fetch all published monthly rows for a fund and upsert into il_fund_cache.
 * Skips the network when the cache was refreshed within the last 24 h.
 */
export async function refreshFundCache(
  db: Database.Database,
  dataset: IlDataset,
  fundId: number,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const newest = db
    .prepare<[string, number], { fetched_at: string } | undefined>(
      `SELECT fetched_at FROM il_fund_cache
       WHERE dataset = ? AND fund_id = ?
       ORDER BY period DESC LIMIT 1`
    )
    .get(dataset, fundId) as { fetched_at: string } | undefined;

  if (newest && Date.now() - new Date(newest.fetched_at).getTime() < FETCH_TTL_MS) return;

  const records = await queryDatastore(
    dataset,
    { filters: JSON.stringify({ FUND_ID: fundId }), limit: "600" },
    fetchImpl
  );

  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO il_fund_cache
       (dataset, fund_id, period, fund_name, fund_classification,
        monthly_yield, avg_annual_mgmt_fee, avg_deposit_fee, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const write = db.transaction(() => {
    for (const r of records) {
      if (!r.REPORT_PERIOD) continue;
      upsert.run(
        dataset, fundId, r.REPORT_PERIOD,
        r.FUND_NAME ?? null, r.FUND_CLASSIFICATION ?? null,
        r.MONTHLY_YIELD ?? null,
        r.AVG_ANNUAL_MANAGEMENT_FEE ?? null,
        r.AVG_DEPOSIT_FEE ?? null,
        now
      );
    }
  });
  write();
}

// ── Estimate current value from last balance + published yields ──────────────

export interface IlEstimateInput {
  /** Last manually-entered balance (fund's native currency, normally NIS). */
  last_balance: number;
  /** ISO date of that balance snapshot. */
  last_balance_at: string;
  /** period (YYYYMM) → monthly yield in percent. Missing months = deposits only. */
  yields: Map<number, number>;
  monthly_deposit?: number | null;
  /** Personal fee on each deposit, percent (e.g. 1.5). */
  fee_deposit_pct?: number | null;
  /** Personal fee on balance, percent per year (e.g. 0.6). */
  fee_balance_pct?: number | null;
  /** "Now" — injectable for tests. */
  now?: Date;
}

export interface IlEstimateResult {
  value: number;
  months_applied: number;      // months folded into the estimate
  months_with_yield: number;   // of those, how many had a published yield
}

/** period arithmetic: 202312 + 1 month → 202401 */
function nextPeriod(p: number): number {
  const y = Math.floor(p / 100);
  const m = p % 100;
  return m === 12 ? (y + 1) * 100 + 1 : p + 1;
}

function toPeriod(d: Date): number {
  return d.getFullYear() * 100 + (d.getMonth() + 1);
}

/**
 * Grow the last known balance month-by-month using published track yields,
 * personal management fees, and the expected monthly contribution.
 * Pure function — no DB, no network.
 */
export function estimateIlFundValue(input: IlEstimateInput): IlEstimateResult {
  const now = input.now ?? new Date();
  const startPeriod = toPeriod(new Date(input.last_balance_at));
  const endPeriod = toPeriod(now);

  const monthlyNet = (input.monthly_deposit ?? 0) * (1 - (input.fee_deposit_pct ?? 0) / 100);
  const balanceFeeMonthly = (input.fee_balance_pct ?? 0) / 100 / 12;

  let value = input.last_balance;
  let months_applied = 0;
  let months_with_yield = 0;

  for (let p = nextPeriod(startPeriod); p <= endPeriod; p = nextPeriod(p)) {
    const y = input.yields.get(p);
    if (y != null) {
      value *= 1 + y / 100;
      months_with_yield++;
    }
    value *= 1 - balanceFeeMonthly;
    value += monthlyNet;
    months_applied++;
  }

  return { value, months_applied, months_with_yield };
}

/**
 * Synchronous, cache-only estimate for the portfolio layer.
 * Returns null when there's nothing to add (no cached yields and no deposits,
 * or the balance is fresh this month).
 */
export function estimateFromCache(
  db: Database.Database,
  dataset: IlDataset,
  fundId: number,
  lastBalance: number,
  lastBalanceAt: string,
  monthlyDeposit: number | null,
  feeDepositPct: number | null,
  feeBalancePct: number | null
): IlEstimateResult | null {
  const rows = db
    .prepare<[string, number], { period: number; monthly_yield: number | null }>(
      `SELECT period, monthly_yield FROM il_fund_cache
       WHERE dataset = ? AND fund_id = ?`
    )
    .all(dataset, fundId) as { period: number; monthly_yield: number | null }[];

  const yields = new Map<number, number>();
  for (const r of rows) {
    if (r.monthly_yield != null) yields.set(r.period, r.monthly_yield);
  }

  const est = estimateIlFundValue({
    last_balance: lastBalance,
    last_balance_at: lastBalanceAt,
    yields,
    monthly_deposit: monthlyDeposit,
    fee_deposit_pct: feeDepositPct,
    fee_balance_pct: feeBalancePct,
  });

  if (est.months_applied === 0) return null;
  if (est.months_with_yield === 0 && !(monthlyDeposit && monthlyDeposit > 0)) return null;
  return est;
}
