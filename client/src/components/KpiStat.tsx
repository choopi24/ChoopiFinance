import type { ReactNode } from "react";
import { Pill } from "./Pill";

interface KpiStatProps {
  label: string;
  value: string;
  change?: number;
  changeLabel?: string;
  sub?: string;
  icon?: ReactNode;
}

export function KpiStat({ label, value, change, changeLabel, sub, icon }: KpiStatProps) {
  return (
    <div className="cf-kpi-stat">
      <div className="cf-kpi-label">
        {icon && <span className="cf-kpi-icon">{icon}</span>}
        {label}
      </div>
      <div className="cf-kpi-value mono">{value}</div>
      {(change !== undefined || sub) && (
        <div className="flex items-center gap-2 mt-1">
          {change !== undefined && (
            <Pill variant={change >= 0 ? "pos" : "neg"}>
              {change >= 0 ? "+" : ""}{change.toFixed(2)}%
            </Pill>
          )}
          {changeLabel && <span className="text-xs text-text-faint">{changeLabel}</span>}
          {sub && !changeLabel && <span className="text-xs text-text-faint">{sub}</span>}
        </div>
      )}
    </div>
  );
}
