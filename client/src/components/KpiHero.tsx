import { useState, type ReactNode } from "react";
import type { Currency } from "@choopi/shared";
import { fmt } from "../lib/fmt";
import { LineChart } from "./LineChart";

interface KpiHeroProps {
  totalValue: number;
  totalValueAlt: number;
  unrealizedPct: number;
  unrealizedAbs: number;
  netInvested: number;
  realizedYtd: number;
  dividendsYtd: number;
  currency: Currency;
  series: { m: string; v: number }[];
  action?: ReactNode;
  fxLabel?: string;
}

function UnrealizedPill({ pct, abs, currency }: { pct: number; abs: number; currency: Currency }) {
  const [show, setShow] = useState(false);
  const isPos = pct >= 0;
  return (
    <span
      className="cf-unrealized-pill"
      data-pos={isPos}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {isPos ? "+" : ""}{pct.toFixed(2)}%
      {show && (
        <span className="cf-pill-tooltip">
          <strong>{isPos ? "+" : ""}{fmt(abs, { currency })}</strong> unrealized gain/loss<br />
          <span style={{ color: "var(--text-faint)", fontSize: 10 }}>
            = (current value − cost basis) / cost basis
          </span>
        </span>
      )}
    </span>
  );
}

export function KpiHero({
  totalValue,
  totalValueAlt,
  unrealizedPct,
  unrealizedAbs,
  netInvested,
  realizedYtd,
  dividendsYtd,
  currency,
  series,
  action,
  fxLabel,
}: KpiHeroProps) {
  const sym = currency === "NIS" ? "₪" : "$";
  const altSym = currency === "NIS" ? "$" : "₪";
  const altCcy: Currency = currency === "NIS" ? "USD" : "NIS";

  return (
    <div className="cf-kpi-hero">
      <div className="cf-kpi-hero-grid">
        {/* Left: main number + chart */}
        <div className="cf-kpi-hero-main">
          <div className="cf-kpi-label">Total portfolio value</div>
          <div className="cf-hero-number serif">
            <span className="cf-hero-sym">{sym}</span>
            {totalValue.toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </div>
          <div className="cf-hero-fx mono">
            ≈ {altSym}{totalValueAlt.toLocaleString("en-US", { maximumFractionDigits: 0 })} {altCcy} at spot
            {fxLabel && (
              <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 11 }}>· {fxLabel}</span>
            )}
          </div>

          <div className="cf-hero-meta">
            <UnrealizedPill pct={unrealizedPct} abs={unrealizedAbs} currency={currency} />
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>unrealized</span>
          </div>

          {action && <div style={{ marginTop: 16 }}>{action}</div>}
        </div>

        {/* Right: chart */}
        <div>
          <LineChart data={series} currency={currency} height={180} gradId="hero-grad" />
        </div>
      </div>

      {/* Bottom stats row */}
      <div className="cf-kpi-hero-stats">
        <div className="cf-kpi-stat">
          <div className="cf-kpi-label">Net Deposited</div>
          <div className="cf-kpi-value mono">{fmt(netInvested, { currency })}</div>
          <div className="cf-kpi-sub mono">
            ≈ {fmt(netInvested / (currency === "NIS" ? 1 : 1), { currency: altCcy })}
          </div>
        </div>
        <div className="cf-kpi-stat">
          <div className="cf-kpi-label">Realized YTD</div>
          <div className={`cf-kpi-value mono ${realizedYtd >= 0 ? "is-pos" : "is-neg"}`}>
            {realizedYtd >= 0 ? "+" : ""}{fmt(realizedYtd, { currency })}
          </div>
          <div className="cf-kpi-sub mono">closed positions</div>
        </div>
        <div className="cf-kpi-stat">
          <div className="cf-kpi-label">Dividends YTD</div>
          <div className={`cf-kpi-value mono ${dividendsYtd > 0 ? "is-pos" : ""}`}>
            {dividendsYtd > 0 ? "+" : ""}{fmt(dividendsYtd, { currency })}
          </div>
          <div className="cf-kpi-sub mono">income received</div>
        </div>
      </div>
    </div>
  );
}
