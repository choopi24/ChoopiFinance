/**
 * Validation + normalization for the two edit endpoints:
 *   PATCH /api/transactions/:id  → validateTransactionPatch
 *   PATCH /api/investments/:id   → validateInvestmentPatchValue
 *
 * Pure functions (no Express, no DB) in the projectionValidation.ts style so
 * the partial-edit semantics are unit-testable:
 *   - only fields present in the body change; absent fields are untouched
 *   - explicit null clears a nullable field
 *   - a BUY/SELL edit that changes units or price re-derives total_amount
 *     (unless total_amount itself was explicitly provided), so the row can
 *     never drift out of sync with its FIFO lot
 */

export type PatchResult =
  | { fields: Record<string, unknown> }
  | { error: string };

const CURRENCIES = new Set(["NIS", "USD"]);
const ETF_KINDS = new Set(["accumulating", "distributing"]);

function asIso(raw: unknown): string | null {
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Transactions ──────────────────────────────────────────────────────────────

/** The columns of the existing row that the merge/derivation needs. */
export interface TxPatchContext {
  kind: string;
  units: number | null;
  price_per_unit: number | null;
  total_amount: number;
}

const TX_EDITABLE = [
  "units", "price_per_unit", "total_amount", "currency",
  "occurred_at", "notes", "fx_rate_at_buy",
] as const;

/**
 * Validate a partial transaction edit against the existing row and return the
 * exact column set to write. Numeric fields must be finite and positive
 * (price may be 0 for zero-cost lots); currency is NIS/USD; occurred_at must
 * parse to a real date (normalized to ISO). units / price_per_unit /
 * fx_rate_at_buy / notes accept explicit null.
 */
export function validateTransactionPatch(
  existing: TxPatchContext,
  body: Record<string, unknown>
): PatchResult {
  const fields: Record<string, unknown> = {};

  for (const key of TX_EDITABLE) {
    if (!(key in body)) continue;
    const raw = body[key];

    switch (key) {
      case "units": {
        if (raw == null || raw === "") { fields.units = null; break; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) return { error: "units must be a positive number" };
        fields.units = v;
        break;
      }
      case "price_per_unit": {
        if (raw == null || raw === "") { fields.price_per_unit = null; break; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) return { error: "price_per_unit must be a non-negative number" };
        fields.price_per_unit = v;
        break;
      }
      case "total_amount": {
        const v = Number(raw);
        if (raw == null || raw === "" || !Number.isFinite(v) || v < 0) {
          return { error: "total_amount must be a non-negative number" };
        }
        fields.total_amount = v;
        break;
      }
      case "currency": {
        const v = String(raw ?? "").toUpperCase();
        if (!CURRENCIES.has(v)) return { error: "currency must be NIS or USD" };
        fields.currency = v;
        break;
      }
      case "occurred_at": {
        const iso = asIso(raw);
        if (!iso) return { error: "occurred_at must be a valid date" };
        fields.occurred_at = iso;
        break;
      }
      case "notes": {
        fields.notes = raw == null ? null : String(raw);
        break;
      }
      case "fx_rate_at_buy": {
        if (raw == null || raw === "") { fields.fx_rate_at_buy = null; break; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) return { error: "fx_rate_at_buy must be a positive number" };
        fields.fx_rate_at_buy = v;
        break;
      }
    }
  }

  if (Object.keys(fields).length === 0) return { error: "No valid fields to update" };

  // ── Keep total_amount consistent with the FIFO lot ──────────────────────────
  // For BUY/SELL, a units or price edit re-derives the total from the merged
  // row unless the caller explicitly set total_amount in the same request.
  const isTrade = existing.kind === "BUY" || existing.kind === "SELL";
  const touchedLot = "units" in fields || "price_per_unit" in fields;
  if (isTrade && touchedLot && !("total_amount" in fields)) {
    const units = ("units" in fields ? fields.units : existing.units) as number | null;
    const price = ("price_per_unit" in fields ? fields.price_per_unit : existing.price_per_unit) as number | null;
    if (units != null && price != null) {
      fields.total_amount = units * price;
    }
  }

  return { fields };
}

// ── Investments ───────────────────────────────────────────────────────────────

/**
 * Validate one investments-PATCH field value (the route iterates its allowed
 * list). Returns the normalized value to store. Rejects values that would
 * otherwise surface as raw SQLite CHECK-constraint 500s.
 */
export function validateInvestmentPatchValue(
  key: string,
  raw: unknown
): { value: unknown } | { error: string } {
  switch (key) {
    case "name": {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (!v) return { error: "name cannot be empty" };
      return { value: v };
    }
    case "etf_kind": {
      if (raw == null || raw === "") return { value: null };
      const v = String(raw).toLowerCase();
      if (!ETF_KINDS.has(v)) return { error: "etf_kind must be accumulating or distributing" };
      return { value: v };
    }
    case "liquid_date": {
      if (raw == null || raw === "") return { value: null };
      const iso = asIso(raw);
      if (!iso) return { error: "liquid_date must be a valid date" };
      return { value: iso.slice(0, 10) };
    }
    case "deposit_currency": {
      const v = String(raw ?? "").toUpperCase();
      if (!CURRENCIES.has(v)) return { error: "deposit_currency must be NIS or USD" };
      return { value: v };
    }
    case "broker":
    case "isin":
    case "fund_track": {
      if (raw == null) return { value: null };
      const v = String(raw).trim();
      return { value: v || null };
    }
    default:
      return { value: raw ?? null };
  }
}
