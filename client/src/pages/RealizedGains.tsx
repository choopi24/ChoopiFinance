import { useState } from "react";
import { createPortal } from "react-dom";
import { EmptyState } from "../components/EmptyState";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useCurrency } from "../hooks/useCurrency";
import { AppShell } from "../components/AppShell";
import { YearBar } from "../components/YearBar";
import { SkeletonCard } from "../components/SkeletonShimmer";
import {
  useRealizedYear, useRealizedYears,
  type RealizedByAsset, type RealizedTransaction,
} from "../hooks/useRealized";
import { fmt } from "../lib/fmt";
import type { Currency } from "@choopi/shared";
import { Download, ChevronDown, ChevronUp, Info } from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  crypto:    "Crypto",
  stock:     "Stocks",
  etf:       "ETFs",
  pension:   "Pension",
  education: "Education Savings",
  other:     "Other",
};

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ── Tax export modal ──────────────────────────────────────────────────────────

function TaxExportModal({ years, onClose }: { years: number[]; onClose: () => void }) {
  const [year, setYear] = useState(years[0] ?? new Date().getFullYear());

  function doExport() {
    const url = `/api/realized/tax-report?year=${year}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `tax-report-${year}.csv`;
    a.click();
    onClose();
  }

  return createPortal(
    <div className="cf-modal-backdrop">
      <div className="cf-delete-modal" style={{ maxWidth: 420 }}>
        <div className="cf-delete-icon">📋</div>
        <h3 style={{ margin: "12px 0 6px", fontSize: 16 }}>Tax Report — Form 1399</h3>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "0 0 16px" }}>
          UTF-8 CSV with BOM. Covers all realized gains and dividends for the selected tax year.
        </p>

        <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: "var(--text-faint)" }}>Tax year</span>
          <select
            className="cf-select"
            value={year}
            onChange={e => setYear(Number(e.target.value))}
          >
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>

        <div style={{
          padding: "10px 12px", background: "var(--surface-2)", borderRadius: 8,
          fontSize: 12, color: "var(--text-faint)", marginBottom: 16,
        }}>
          <strong style={{ color: "var(--text)" }}>Note:</strong> Amounts are in the original transaction currency.
          Convert to NIS at the exchange rate on the transaction date per tax authority guidelines.
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="cf-btn cf-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="cf-btn cf-btn-grad" onClick={doExport}>
            <Download size={13} /> Download CSV
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Asset row with drill-down ─────────────────────────────────────────────────

function AssetRow({
  asset,
  transactions,
}: {
  asset: RealizedByAsset;
  transactions: RealizedTransaction[];
}) {
  const [expanded, setExpanded] = useState(false);
  const assetTxs = transactions.filter(t => t.investment_id === asset.investment_id);
  const typeLabel = TYPE_LABELS[asset.type] ?? asset.type;
  const total = asset.realized + asset.dividends;

  return (
    <>
      <tr
        className="cf-tx-row"
        onClick={() => setExpanded(x => !x)}
        style={{ cursor: "pointer" }}
      >
        <td>
          <div style={{ fontWeight: 500 }}>{asset.name}</div>
          {asset.ticker && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{asset.ticker}</div>}
        </td>
        <td>{typeLabel}</td>
        <td style={{ textAlign: "right" }}>{asset.count}</td>
        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: asset.realized >= 0 ? "var(--emerald)" : "var(--rose)" }}>
          {asset.realized >= 0 ? "+" : ""}{fmt(asset.realized, { currency: "NIS" })}
        </td>
        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: asset.dividends > 0 ? "var(--emerald)" : undefined }}>
          {asset.dividends > 0 ? "+" : ""}{fmt(asset.dividends, { currency: "NIS" })}
        </td>
        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: total >= 0 ? "var(--emerald)" : "var(--rose)" }}>
          {total >= 0 ? "+" : ""}{fmt(total, { currency: "NIS" })}
        </td>
        <td style={{ width: 28 }}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </td>
      </tr>
      {expanded && assetTxs.map(tx => (
        <tr key={tx.id} style={{ background: "var(--surface-2)" }}>
          <td colSpan={2} style={{ paddingLeft: 24, fontSize: 12, color: "var(--text-faint)" }}>
            {fmtDate(tx.occurred_at)} — {tx.kind === "DIV" ? "Dividend" : "Sell"}
          </td>
          <td></td>
          <td style={{ textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums", color: (tx.realized_pl ?? 0) >= 0 ? "var(--emerald)" : "var(--rose)" }}>
            {tx.kind === "SELL" ? (tx.realized_pl != null ? fmt(tx.realized_pl, { currency: "NIS" }) : "—") : "—"}
          </td>
          <td style={{ textAlign: "right", fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--emerald)" }}>
            {tx.kind === "DIV" ? fmt(tx.total_amount, { currency: "NIS" }) : "—"}
          </td>
          <td></td>
          <td></td>
        </tr>
      ))}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RealizedGainsPage() {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [taxModalOpen, setTaxModalOpen] = useState(false);

  const { data: yearsData, isLoading: yearsLoading } = useRealizedYears();
  const { data: yearData, isLoading: yearLoading } = useRealizedYear(selectedYear);

  const years = yearsData ?? [];
  const yearNums = years.map(y => y.year);

  const displayYears = yearNums.includes(currentYear)
    ? years
    : [{ year: currentYear, total: 0, capital_gains: 0, dividends: 0, count: 0 }, ...years];

  const maxAbs = Math.max(...displayYears.map(y => Math.abs(y.total)), 1);
  const summary = yearData?.summary;
  const byAsset = yearData?.by_asset ?? [];
  const transactions = yearData?.transactions ?? [];

  const gains = summary ? Math.max(0, summary.capital_gains) : 0;
  const losses = summary ? Math.min(0, summary.capital_gains) : 0;
  const total = summary ? summary.total : 0;
  const tradeCount = summary?.trade_count ?? 0;

  return (
    <AppShell
      theme={theme}
      onThemeToggle={toggleTheme}
      currency={currency as Currency}
      onCurrencyChange={c => setCurrency(c)}
      userName={user?.username}
      onLogout={logout}
    >
      <div className="cf-page-header">
        <div>
          <h1 className="cf-page-title">Realized Gains</h1>
          <p className="cf-page-sub">Annual summary · FIFO basis</p>
        </div>
        <button className="cf-btn cf-btn-secondary" onClick={() => setTaxModalOpen(true)}>
          <Download size={14} /> Tax Report 1399
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20, alignItems: "start" }}>
        {/* Left: year KPI + breakdown table */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Year selector tabs */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {displayYears.map(y => (
              <button
                key={y.year}
                className={["cf-chip", selectedYear === y.year ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => setSelectedYear(y.year)}
              >
                {y.year}
              </button>
            ))}
          </div>

          {/* KPI summary card */}
          <div className="cf-card">
            {yearLoading ? (
              <SkeletonCard lines={3} />
            ) : (
              <>
                <div style={{ marginBottom: 4, fontSize: 12, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Total realized {selectedYear}
                </div>
                <div className="cf-hero-number" style={{ fontSize: 40, lineHeight: 1 }}>
                  <span className="cf-hero-sym" style={{ fontSize: 24 }}>₪</span>
                  <span style={{ color: total >= 0 ? "var(--emerald)" : "var(--rose)" }}>
                    {total >= 0 ? "+" : ""}{Math.abs(total).toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  </span>
                </div>

                <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                  <div style={{
                    padding: "3px 10px", borderRadius: 999, background: "var(--surface-2)",
                    fontSize: 11, color: "var(--text-faint)", display: "flex", alignItems: "center", gap: 4,
                  }}>
                    <Info size={10} /> FIFO
                  </div>
                  <span style={{ fontSize: 12, color: "var(--text-faint)" }}>{tradeCount} closed trades</span>
                </div>

                <div className="cf-kpi-hero-stats" style={{ marginTop: 20 }}>
                  <div className="cf-kpi-stat">
                    <div className="cf-kpi-label">Capital Gains</div>
                    <div className="cf-kpi-value mono is-pos">
                      +{fmt(gains, { currency })}
                    </div>
                    <div className="cf-kpi-sub">Profitable sells</div>
                  </div>
                  <div className="cf-kpi-stat">
                    <div className="cf-kpi-label">Capital Losses</div>
                    <div className="cf-kpi-value mono is-neg">
                      {fmt(losses, { currency })}
                    </div>
                    <div className="cf-kpi-sub">Losing sells</div>
                  </div>
                  <div className="cf-kpi-stat">
                    <div className="cf-kpi-label">Dividends</div>
                    <div className={`cf-kpi-value mono ${(summary?.dividends ?? 0) > 0 ? "is-pos" : ""}`}>
                      {(summary?.dividends ?? 0) > 0 ? "+" : ""}{fmt(summary?.dividends ?? 0, { currency })}
                    </div>
                    <div className="cf-kpi-sub">Passive income</div>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Per-asset breakdown */}
          {!yearLoading && byAsset.length > 0 && (
            <div className="cf-card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px 12px", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: 14 }}>
                Breakdown by asset
              </div>
              <div className="cf-tx-table-wrap">
                <table className="cf-tx-table">
                  <thead>
                    <tr>
                      <th scope="col">Asset</th>
                      <th scope="col">Type</th>
                      <th scope="col" style={{ textAlign: "right" }}>Trades</th>
                      <th scope="col" style={{ textAlign: "right" }}>Capital Gain</th>
                      <th scope="col" style={{ textAlign: "right" }}>Dividend</th>
                      <th scope="col" style={{ textAlign: "right" }}>Total</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {byAsset.map(asset => (
                      <AssetRow key={asset.investment_id} asset={asset} transactions={transactions} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!yearLoading && byAsset.length === 0 && (
            <div className="cf-card" style={{ padding: 0 }}>
              <EmptyState
                icon="📊"
                title={`No realized gains in ${selectedYear}`}
                description="Sell an investment to start tracking realized gains and losses."
              />
            </div>
          )}
        </div>

        {/* Right: YearBar chart */}
        <div className="cf-card" style={{ position: "sticky", top: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>All years</div>
          {yearsLoading ? (
            <SkeletonCard lines={4} />
          ) : displayYears.length === 0 ? (
            <EmptyState icon="📈" title="No data yet" description="Realized gains will appear here after your first sell." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {displayYears.map(y => (
                <YearBar
                  key={y.year}
                  data={{
                    year: y.year,
                    total: y.total,
                    dividends: y.dividends,
                    capital: y.capital_gains,
                    count: y.count,
                  }}
                  maxAbs={maxAbs}
                  currency={currency}
                  expanded={selectedYear === y.year}
                  onClick={() => setSelectedYear(y.year)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {taxModalOpen && (
        <TaxExportModal
          years={yearNums.length > 0 ? yearNums : [currentYear]}
          onClose={() => setTaxModalOpen(false)}
        />
      )}
    </AppShell>
  );
}
