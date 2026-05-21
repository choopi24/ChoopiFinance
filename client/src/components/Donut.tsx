import { useState } from "react";
import { fmt } from "../lib/fmt";
import type { Currency } from "@choopi/shared";

interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

interface DonutProps {
  data: DonutSlice[];
  currency?: Currency;
  size?: number;
  thickness?: number;
}

export function Donut({ data, currency = "NIS", size = 168, thickness = 26 }: DonutProps) {
  const [active, setActive] = useState<number | null>(null);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const total = data.reduce((s, d) => s + d.value, 0);

  // Guard: render empty ring when all values are zero
  if (total === 0) {
    return (
      <div className="cf-alloc-body">
        <div className="cf-donut" style={{ width: size, height: size }}>
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
          </svg>
          <div className="cf-donut-center">
            <div className="text-xs text-text-faint">Total</div>
            <div className="text-sm font-semibold mono">{fmt(0, { currency })}</div>
          </div>
        </div>
        <ul className="cf-alloc-legend">
          {data.map((d, i) => (
            <li key={i}>
              <span className="cf-swatch" style={{ background: d.color }} />
              <span className="cf-alloc-name">{d.label}</span>
              <span className="cf-alloc-pct mono">—</span>
              <span className="cf-alloc-val mono">{fmt(0, { currency })}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  let offset = 0;
  const slices = data.map((d, i) => {
    const pct = d.value / total;
    const dash = pct * circ;
    const gap = circ - dash;
    const slice = { ...d, dash, gap, offset: circ * (1 - offset) - dash, i };
    offset += pct;
    return slice;
  });

  const activeSlice = active !== null ? data[active] : null;

  return (
    <div className="cf-alloc-body">
      <div className="cf-donut" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Background track */}
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
          {slices.map((s) => (
            <circle
              key={s.i}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={active === s.i ? thickness + 4 : thickness}
              strokeDasharray={`${s.dash} ${s.gap}`}
              strokeDashoffset={s.offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ cursor: "pointer", transition: "stroke-width 0.15s" }}
              onMouseEnter={() => setActive(s.i)}
              onMouseLeave={() => setActive(null)}
            />
          ))}
        </svg>
        <div className="cf-donut-center">
          {activeSlice ? (
            <>
              <div className="text-xs text-text-faint">{activeSlice.label}</div>
              <div className="text-sm font-semibold mono">{fmt(activeSlice.value, { currency })}</div>
              <div className="text-xs text-text-faint mono">
                {((activeSlice.value / total) * 100).toFixed(1)}%
              </div>
            </>
          ) : (
            <>
              <div className="text-xs text-text-faint">Total</div>
              <div className="text-sm font-semibold mono">{fmt(total, { currency })}</div>
            </>
          )}
        </div>
      </div>

      <ul className="cf-alloc-legend">
        {data.map((d, i) => (
          <li
            key={i}
            style={{ opacity: active !== null && active !== i ? 0.45 : 1, transition: "opacity 0.15s" }}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
          >
            <span className="cf-swatch" style={{ background: d.color }} />
            <span className="cf-alloc-name">{d.label}</span>
            <span className="cf-alloc-pct mono">{((d.value / total) * 100).toFixed(0)}%</span>
            <span className="cf-alloc-val mono">{fmt(d.value, { currency })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
