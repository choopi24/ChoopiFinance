import { useState, useRef, useCallback } from "react";
import { fmt } from "../lib/fmt";
import type { Currency } from "@choopi/shared";

interface DataPoint {
  m: string;
  v: number;
}

interface LineChartProps {
  data: DataPoint[];
  currency?: Currency;
  height?: number;
  gradId?: string;
}

function catmullRom(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export function LineChart({ data, currency = "NIS", height = 160, gradId = "lc-grad" }: LineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const W = 560;
  const H = height;
  const PAD = { top: 12, right: 12, bottom: 24, left: 4 };
  const min = Math.min(...data.map((d) => d.v)) * 0.98;
  const max = Math.max(...data.map((d) => d.v)) * 1.01;

  const xScale = (i: number) =>
    PAD.left + (i / (data.length - 1)) * (W - PAD.left - PAD.right);
  const yScale = (v: number) =>
    PAD.top + ((max - v) / (max - min)) * (H - PAD.top - PAD.bottom);

  const pts: [number, number][] = data.map((d, i) => [xScale(i), yScale(d.v)]);
  const linePath = catmullRom(pts);
  const areaPath = linePath
    ? `${linePath} L ${pts[pts.length - 1][0]} ${H - PAD.bottom} L ${pts[0][0]} ${H - PAD.bottom} Z`
    : "";

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * W;
      let closest = 0;
      let minDist = Infinity;
      pts.forEach(([x], i) => {
        const d = Math.abs(x - px);
        if (d < minDist) { minDist = d; closest = i; }
      });
      setHover({ idx: closest, x: pts[closest][0], y: pts[closest][1] });
    },
    [pts]
  );

  return (
    <div className="cf-linechart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height, overflow: "visible" }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.10" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Area fill */}
        <path d={areaPath} fill={`url(#${gradId})`} />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* X-axis labels */}
        {data.map((d, i) => {
          if (i % Math.ceil(data.length / 6) !== 0 && i !== data.length - 1) return null;
          return (
            <text
              key={i}
              x={xScale(i)}
              y={H - PAD.bottom + 14}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text-faint)"
              fontFamily="var(--font-mono)"
            >
              {d.m}
            </text>
          );
        })}

        {/* Hover scrubber */}
        {hover && (
          <>
            <line
              x1={hover.x} y1={PAD.top}
              x2={hover.x} y2={H - PAD.bottom}
              stroke="var(--border-strong)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle cx={hover.x} cy={hover.y} r={4} fill="var(--accent)" stroke="var(--bg)" strokeWidth={2} />
            <rect
              x={Math.min(hover.x + 6, W - 100)}
              y={hover.y - 22}
              width={96}
              height={20}
              rx={4}
              fill="var(--surface)"
              stroke="var(--border)"
            />
            <text
              x={Math.min(hover.x + 54, W - 52)}
              y={hover.y - 8}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text)"
              fontFamily="var(--font-mono)"
            >
              {fmt(data[hover.idx].v, { currency })}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
