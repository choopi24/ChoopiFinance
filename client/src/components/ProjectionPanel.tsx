import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { LineChart } from "./LineChart";
import { useEditInvestment } from "../hooks/useInvestments";
import { toDisplayCurrency } from "../hooks/usePortfolio";
import { projectFutureValue } from "../lib/projection";
import { fmt } from "../lib/fmt";
import { DEFAULT_ANNUAL_RETURNS } from "@choopi/shared";
import type { AssetType, Currency } from "@choopi/shared";
import type { Investment } from "../hooks/useInvestments";

interface ProjectionPanelProps {
  investment: Investment;
  currency: Currency;
  fxRate: number;
  onClose: () => void;
}

const YEARS_MIN = 10;
const YEARS_MAX = 30;
const YEARS_DEFAULT = 20;
const DEBOUNCE_MS = 600;

export function ProjectionPanel({ investment: inv, currency, fxRate, onClose }: ProjectionPanelProps) {
  const editMut = useEditInvestment();

  // Per-type fallback return (decimal) when the investment has none stored.
  const defaultReturn = DEFAULT_ANNUAL_RETURNS[inv.type as AssetType] ?? 0.05;

  const [years, setYears] = useState(YEARS_DEFAULT);
  // Return is edited as a percentage; contribution is edited in the display currency.
  const [returnPct, setReturnPct] = useState(() =>
    String(+(((inv.expected_annual_return ?? defaultReturn) * 100).toFixed(2)))
  );
  const [contribInput, setContribInput] = useState(() =>
    inv.monthly_contribution != null
      ? String(Math.round(toDisplayCurrency(inv.monthly_contribution, currency, fxRate)))
      : ""
  );

  // ── Live present value ──────────────────────────────────────────────────────
  // PV is derived from inv.current_value_nis on every render. Investments.tsx passes
  // the *live* row from the useInvestments query (looked up by id), and deposits, BUYs
  // and balance UPDATEs all invalidate the ["investments"] query — so this panel
  // receives the refreshed current_value_nis and the projection re-computes
  // automatically, with no manual refresh. (Verified: see useInvestments mutations,
  // which invalidate ["investments"], and Investments.tsx passing the live row.)
  const pv = toDisplayCurrency(inv.current_value_nis, currency, fxRate);

  const returnDecimal = returnPct === "" ? 0 : Number(returnPct) / 100;
  const contribDisplay = contribInput === "" ? 0 : Number(contribInput);

  const series = useMemo(
    () =>
      projectFutureValue({
        presentValue: pv,
        annualReturn: Number.isFinite(returnDecimal) ? returnDecimal : 0,
        monthlyContribution: Number.isFinite(contribDisplay) ? contribDisplay : 0,
        years,
      }),
    [pv, returnDecimal, contribDisplay, years]
  );
  const projectedEnd = series.at(-1)?.value ?? pv;
  const chartData = series.map(p => ({ m: String(p.year), v: p.value }));

  // ── Debounced persistence of return + contribution ──────────────────────────
  // Canonical storage: expected_annual_return as a decimal, monthly_contribution in NIS.
  //
  // `edited` gates persistence on an actual user keystroke: the contribution seed
  // is rounded to whole units in the DISPLAY currency, so on mount the recomputed
  // NIS value can differ from the stored one — without the gate, merely opening
  // the panel would PATCH that rounding drift to the server.
  //
  // `pending` holds the latest unsaved values so closing the panel before the
  // debounce fires flushes the edit instead of silently dropping it.
  const edited = useRef(false);
  const pending = useRef<{ ret: number | null; contrib: number | null } | null>(null);

  useEffect(() => {
    if (!edited.current) return;

    const persistedReturn = inv.expected_annual_return ?? null;
    const persistedContribNis = inv.monthly_contribution ?? null;

    const nextReturn = returnPct === "" ? null : +(Number(returnPct) / 100).toFixed(4);
    const nextContribNis =
      contribInput === ""
        ? null
        : Math.round((currency === "USD" ? contribDisplay * fxRate : contribDisplay) * 100) / 100;

    // No change → nothing pending to persist.
    if (nextReturn === persistedReturn && nextContribNis === persistedContribNis) {
      pending.current = null;
      return;
    }
    // Skip obviously invalid input rather than PATCHing NaN.
    if (returnPct !== "" && !Number.isFinite(nextReturn as number)) return;
    if (contribInput !== "" && !Number.isFinite(nextContribNis as number)) return;

    pending.current = { ret: nextReturn, contrib: nextContribNis };
    const t = setTimeout(() => {
      pending.current = null;
      editMut.mutate({
        id: inv.id,
        body: { expected_annual_return: nextReturn, monthly_contribution: nextContribNis },
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
    // editMut is stable; intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    returnPct, contribInput, contribDisplay, currency, fxRate,
    inv.id, inv.expected_annual_return, inv.monthly_contribution,
  ]);

  // Flush any debounce-pending edit on close so it isn't lost with the timer.
  function handleClose() {
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      editMut.mutate({
        id: inv.id,
        body: { expected_annual_return: p.ret, monthly_contribution: p.contrib },
      });
    }
    onClose();
  }

  return (
    <Modal open onClose={handleClose} title={`Projection — ${inv.name}`} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Controls */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div className="cf-field" style={{ gridColumn: "1 / -1" }}>
            <label>
              Horizon: <span className="mono">{years}</span> years
            </label>
            <input
              type="range"
              min={YEARS_MIN}
              max={YEARS_MAX}
              step={1}
              value={years}
              onChange={e => setYears(Number(e.target.value))}
              style={{ accentColor: "var(--accent)" }}
            />
          </div>

          <div className="cf-field">
            <label>Annual return (%)</label>
            <input
              type="number"
              step="0.1"
              className="cf-num"
              value={returnPct}
              onChange={e => { edited.current = true; setReturnPct(e.target.value); }}
              placeholder={String(+(defaultReturn * 100).toFixed(2))}
            />
          </div>

          <div className="cf-field">
            <label>Monthly contribution ({currency}, optional)</label>
            <input
              type="number"
              min="0"
              step="any"
              className="cf-num"
              value={contribInput}
              onChange={e => { edited.current = true; setContribInput(e.target.value); }}
              placeholder="0"
            />
          </div>
        </div>

        {/* Summary figures */}
        <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
          <div>
            <div className="cf-proj-cap">Present value</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
              {fmt(pv, { currency })}
            </div>
          </div>
          <div>
            <div className="cf-proj-cap">Projected in {years}y</div>
            <div
              className={`mono ${projectedEnd >= pv ? "is-pos" : "is-neg"}`}
              style={{ fontSize: 18, fontWeight: 600 }}
            >
              {fmt(projectedEnd, { currency })}
            </div>
          </div>
        </div>

        {/* Yearly series */}
        <LineChart data={chartData} currency={currency} height={180} gradId={`proj-${inv.id}`} />
      </div>
    </Modal>
  );
}
