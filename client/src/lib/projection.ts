/**
 * Future-value projection (pure, no UI / no deps).
 *
 * Continuous compounding, with the monthly contribution modelled as a continuous
 * annual cash flow (C = monthlyContribution * 12):
 *   FV = PV * e^(r*t) + C * (e^(r*t) - 1) / r      // r !== 0
 *   FV = PV + C * t                                 // r === 0  (= PV + monthlyContribution * months)
 * where r = annualReturn and t = years.
 *
 * The yearly series is sampled at each whole year, 0..years inclusive.
 */

export interface ProjectionInput {
  /** Starting amount (today's value). */
  presentValue: number;
  /** Expected annual return as a decimal, e.g. 0.07 = 7%/yr. May be negative. */
  annualReturn: number;
  /** Recurring monthly contribution (modelled as a continuous annual flow). Defaults to 0. */
  monthlyContribution?: number;
  /** Projection horizon in whole years (>= 0). */
  years: number;
}

export interface ProjectionPoint {
  year: number;
  value: number;
}

export function projectFutureValue({
  presentValue,
  annualReturn,
  monthlyContribution = 0,
  years,
}: ProjectionInput): ProjectionPoint[] {
  const r = annualReturn;
  const annualContribution = monthlyContribution * 12; // continuous annual cash flow
  const totalYears = Math.max(0, Math.floor(years));

  const points: ProjectionPoint[] = [];
  for (let y = 0; y <= totalYears; y++) {
    const growth = Math.exp(r * y);
    const contrib = r === 0 ? annualContribution * y : annualContribution * (growth - 1) / r;
    points.push({ year: y, value: presentValue * growth + contrib });
  }

  return points;
}
