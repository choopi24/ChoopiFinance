/**
 * Future projection — the compound-interest calculator.
 *
 * Everything else in calc/ describes the past from recorded facts. This module
 * is the one deliberate exception: it answers "what COULD this grow to", from
 * assumptions you type in. Nothing here feeds back into the ledger, and every
 * number it returns is labelled a projection by the shape of the API itself.
 *
 * THE MODEL, month by month (the order matters and is part of the contract):
 *
 *   1. growth   value ×= (1 + g)          g = (1 + annual)^(1/12) − 1
 *   2. fee      value −= value × f        f = annual_balance_fee / 12
 *   3. deposit  value += c × (1 − d)      c = monthly contribution,
 *                                         d = deposit fee fraction
 *
 * Choices, and why:
 *   • g is the GEOMETRIC monthly rate, so 12 months at g compounds to exactly
 *     the stated annual return — an "8%" projection really grows 8%/year.
 *   • The balance fee is charged monthly on the post-growth balance, which is
 *     how Israeli funds actually bill (דמי ניהול מצבירה accrue monthly).
 *     f uses simple division (annual/12) for the same reason — funds quote a
 *     nominal annual rate and charge a twelfth of it, they don't compound it.
 *   • Contributions land at month END (after growth), so a deposit never earns
 *     growth in the month it arrives. This is the conservative convention and
 *     matches the closed-form ordinary-annuity formula the tests check against.
 *
 * The output decomposes with the SAME identity as the rest of the app:
 *     value = principal + net_earnings
 *     gross_earnings = net_earnings + fees
 * where principal = starting value + gross contributions to date. Early months
 * of a high-fee account can therefore show negative earnings — that is honest,
 * not a bug: the fees really would eat the growth.
 *
 * Internals run in floating-point minor units and round only at each emitted
 * point, so a 40-year projection doesn't accumulate 480 rounding steps.
 */

export interface ProjectionInput {
  /** Where the account stands today, in minor units of its own currency. */
  start_value_minor: number;
  /** Gross monthly contribution (before any deposit fee). 0 for passive. */
  monthly_contribution_minor: number;
  /** Assumed annual return, percent — e.g. 6 for 6%/year. May be negative. */
  annual_return_pct: number;
  /** דמי ניהול מצבירה, percent per year on the balance. */
  annual_balance_fee_pct: number;
  /** דמי ניהול מהפקדה, percent taken off each contribution. */
  deposit_fee_pct: number;
  /** Horizon in months. */
  months: number;
  /** Emit a point every N months (default 12). The final month always emits. */
  sample_every?: number;
}

export interface ProjectionPoint {
  /** Months from now; 0 is today. */
  month: number;
  value_minor: number;
  /** start value + gross contributions so far — money from your pocket. */
  principal_minor: number;
  /** Cumulative gross contributions (excluding the starting value). */
  contributed_minor: number;
  /** Cumulative projected fees: balance fees + deposit fees. */
  fees_minor: number;
  /** value − principal. Negative when fees outrun growth — deliberately so. */
  earnings_minor: number;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  /** The final point again, for callers that only want the headline. */
  final: ProjectionPoint;
  /** The effective monthly rates actually used, for display. */
  monthly_growth_rate: number;
  monthly_fee_rate: number;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
}

/**
 * Run the projection. Pure, deterministic, no dates — the caller decides what
 * "month 0" means in calendar terms.
 */
export function project(input: ProjectionInput): ProjectionResult {
  const {
    start_value_minor: start,
    monthly_contribution_minor: contribution,
    annual_return_pct,
    annual_balance_fee_pct,
    deposit_fee_pct,
    months,
  } = input;

  assertFinite(start, "start_value_minor");
  assertFinite(contribution, "monthly_contribution_minor");
  assertFinite(annual_return_pct, "annual_return_pct");
  if (start < 0) throw new Error("start_value_minor cannot be negative");
  if (contribution < 0) throw new Error("monthly_contribution_minor cannot be negative");
  if (!Number.isInteger(months) || months < 0 || months > 1200) {
    throw new Error("months must be a whole number between 0 and 1200");
  }
  // A −100% year would zero the account; anything past it is meaningless.
  if (annual_return_pct <= -100) throw new Error("annual_return_pct must be above −100");
  if (annual_balance_fee_pct < 0 || annual_balance_fee_pct > 100) {
    throw new Error("annual_balance_fee_pct must be between 0 and 100");
  }
  if (deposit_fee_pct < 0 || deposit_fee_pct > 100) {
    throw new Error("deposit_fee_pct must be between 0 and 100");
  }

  const g = Math.pow(1 + annual_return_pct / 100, 1 / 12) - 1;
  const f = annual_balance_fee_pct / 100 / 12;
  const d = deposit_fee_pct / 100;
  const sampleEvery = Math.max(1, Math.round(input.sample_every ?? 12));

  let value = start;
  let contributed = 0;
  let fees = 0;

  const emit = (month: number): ProjectionPoint => {
    const principal = Math.round(start + contributed);
    const v = Math.round(value);
    return {
      month,
      value_minor: v,
      principal_minor: principal,
      contributed_minor: Math.round(contributed),
      fees_minor: Math.round(fees),
      earnings_minor: v - principal,
    };
  };

  const points: ProjectionPoint[] = [emit(0)];

  for (let m = 1; m <= months; m++) {
    value *= 1 + g;                    // 1. growth
    const balanceFee = value * f;      // 2. fee on the post-growth balance
    value -= balanceFee;
    fees += balanceFee;
    if (contribution > 0) {            // 3. contribution, net of deposit fee
      const depositFee = contribution * d;
      value += contribution - depositFee;
      fees += depositFee;
      contributed += contribution;
    }
    if (m % sampleEvery === 0 || m === months) points.push(emit(m));
  }

  return {
    points,
    final: points[points.length - 1],
    monthly_growth_rate: g,
    monthly_fee_rate: f,
  };
}

/**
 * The monthly contribution a set of recurring rules amounts to.
 *
 * Quarterly and annual rules are spread evenly — a projection is a smooth
 * curve, not a calendar. Rules that are inactive, or already past their end
 * date, contribute nothing; a rule ending mid-horizon is still counted in
 * full, because "my salary deposits continue" is the stated assumption of the
 * whole exercise and half-modelling one rule's end date would imply a
 * precision the other assumptions don't have.
 */
export function monthlyContributionOf(
  rules: { frequency: string; amount_minor: number; is_active: number; end_date: string | null }[],
  asOf: string
): number {
  const PER_MONTH: Record<string, number> = { monthly: 1, quarterly: 1 / 3, annual: 1 / 12 };
  let total = 0;
  for (const r of rules) {
    if (!r.is_active) continue;
    if (r.end_date && r.end_date < asOf) continue;
    total += r.amount_minor * (PER_MONTH[r.frequency] ?? 1);
  }
  return Math.round(total);
}
