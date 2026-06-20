/**
 * Validation helpers for the future-value projection fields accepted by
 * PATCH /api/investments/:id. Pure functions so they're unit-testable without
 * spinning up Express or a DB.
 *
 * Each returns either a normalised `{ value }` (number or null) or an `{ error }`.
 */

export type FieldResult = { value: number | null } | { error: string };

export function isError(r: FieldResult): r is { error: string } {
  return "error" in r;
}

/** expected_annual_return: decimal rate in [-1, 1]. null/"" clears it (client falls back to default). */
export function validateExpectedAnnualReturn(raw: unknown): FieldResult {
  if (raw == null || raw === "") return { value: null };
  const v = Number(raw);
  if (isNaN(v) || v < -1 || v > 1) {
    return { error: "expected_annual_return must be a number between -1 and 1" };
  }
  return { value: v };
}

/** monthly_contribution: >= 0 or null. null/"" clears it. */
export function validateMonthlyContribution(raw: unknown): FieldResult {
  if (raw == null || raw === "") return { value: null };
  const v = Number(raw);
  if (isNaN(v) || v < 0) {
    return { error: "monthly_contribution must be a non-negative number or null" };
  }
  return { value: v };
}
