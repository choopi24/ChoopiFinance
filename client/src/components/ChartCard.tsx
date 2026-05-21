import { useState } from "react";
import type { Currency } from "@choopi/shared";
import { Card } from "./Card";
import { LineChart } from "./LineChart";
import { usePortfolioHistory } from "../hooks/usePortfolio";
import { fmt } from "../lib/fmt";

type Range = "1M" | "3M" | "1Y" | "ALL";
const RANGES: Range[] = ["1M", "3M", "1Y", "ALL"];

function snapLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
}

interface ChartCardProps {
  currency: Currency;
  fxRate: number;
  totalValue: number;
}

export function ChartCard({ currency, fxRate, totalValue }: ChartCardProps) {
  const [range, setRange] = useState<Range>("1Y");
  const { data: history } = usePortfolioHistory(range);

  const series = (history?.snapshots ?? []).map(snap => ({
    m: snapLabel(snap.snapshot_at),
    v: currency === "USD"
      ? snap.total_value_nis / fxRate
      : snap.total_value_nis,
  }));

  const displaySeries = series.length > 0
    ? series
    : [{ m: "Now", v: totalValue }];

  const first = displaySeries[0]?.v ?? 0;
  const last  = displaySeries[displaySeries.length - 1]?.v ?? 0;
  const change = first > 0 ? ((last - first) / first) * 100 : 0;
  const isPos = change >= 0;

  return (
    <Card pad={false} className="cf-chart-card">
      <div className="cf-card-head">
        <div>
          <div className="cf-card-title">Portfolio history</div>
          {series.length > 1 && (
            <div className="cf-card-sub mono" style={{ color: isPos ? "var(--emerald)" : "var(--rose)" }}>
              {isPos ? "+" : ""}{change.toFixed(2)}% over {range}
              {" · "}
              <span style={{ color: "var(--text-faint)" }}>{fmt(last, { currency })}</span>
            </div>
          )}
        </div>
        <div className="cf-segment cf-segment-sm">
          {RANGES.map(r => (
            <button
              key={r}
              className={range === r ? "is-on" : ""}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="cf-linechart">
        <LineChart data={displaySeries} currency={currency} height={220} gradId="chart-grad" />
      </div>
    </Card>
  );
}
