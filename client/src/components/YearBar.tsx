import { fmt } from "../lib/fmt";
import type { Currency } from "@choopi/shared";

interface YearBarData {
  year: number;
  total: number;
  dividends: number;
  capital: number;
  count: number;
}

interface YearBarProps {
  data: YearBarData;
  maxAbs: number;
  currency: Currency;
  expanded?: boolean;
  onClick?: () => void;
}

export function YearBar({ data, maxAbs, currency, expanded, onClick }: YearBarProps) {
  const isPos = data.total >= 0;
  const widthPct = Math.min(Math.abs(data.total) / maxAbs, 1) * 100;

  return (
    <div
      className={["cf-year-bar", expanded ? "is-on" : ""].filter(Boolean).join(" ")}
      onClick={onClick}
      style={{ cursor: onClick ? "pointer" : undefined }}
    >
      <div className="cf-year-bar-head">
        <span className="cf-year-bar-year mono">{data.year}</span>
        <span className={["cf-year-bar-num mono", isPos ? "is-pos" : "is-neg"].join(" ")}>
          {isPos ? "+" : ""}{fmt(data.total, { currency })}
        </span>
        <span className="text-text-faint text-xs mono" style={{ marginLeft: "auto" }}>{data.count} trades</span>
      </div>

      {/* Horizontal bar */}
      <div style={{
        width: "100%", height: 6,
        background: "var(--bg-alt)",
        borderRadius: 999, overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${widthPct}%`,
          borderRadius: 999,
          background: isPos
            ? "linear-gradient(90deg, var(--emerald), color-mix(in oklab, var(--emerald) 60%, transparent))"
            : "linear-gradient(90deg, var(--rose), color-mix(in oklab, var(--rose) 60%, transparent))",
          transition: "width 0.4s cubic-bezier(0.4,0,0.2,1)",
        }} />
      </div>

      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--text-faint)" }}>Dividends</span>
            <span className="mono is-pos">+{fmt(data.dividends, { currency })}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--text-faint)" }}>Capital gains</span>
            <span className={["mono", data.capital >= 0 ? "is-pos" : "is-neg"].join(" ")}>
              {data.capital >= 0 ? "+" : ""}{fmt(data.capital, { currency })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
