import type { AssetType } from "@choopi/shared";

const TYPE_CONFIG: Record<AssetType, { label: string; bg: string; color: string; letter: string }> = {
  crypto:       { label: "Crypto",       bg: "var(--c-crypto)",  color: "#fff", letter: "₿" },
  stock:        { label: "Stock",        bg: "var(--c-stocks)",  color: "#fff", letter: "S" },
  etf:          { label: "ETF",          bg: "var(--c-etf)",     color: "#fff", letter: "E" },
  pension:      { label: "Pension",      bg: "var(--c-pension)", color: "#fff", letter: "P" },
  gemel:        { label: "Gemel",        bg: "var(--c-gemel)",   color: "#fff", letter: "ג" },
  education:    { label: "Study fund",   bg: "var(--c-edu)",     color: "#fff", letter: "🎓" },
  money_market: { label: "Money market", bg: "var(--c-mm)",      color: "#fff", letter: "₪" },
  other:        { label: "Other",        bg: "var(--c-other)",   color: "#fff", letter: "·" },
};

/** CSS var per asset type — for pills, charts, and anywhere a type colour is needed. */
export const TYPE_COLOR_VAR: Record<AssetType, string> = {
  crypto: "var(--c-crypto)",
  stock: "var(--c-stocks)",
  etf: "var(--c-etf)",
  pension: "var(--c-pension)",
  gemel: "var(--c-gemel)",
  education: "var(--c-edu)",
  money_market: "var(--c-mm)",
  other: "var(--c-other)",
};

interface AssetIconProps {
  type: AssetType;
  ticker?: string;
  size?: number;
  className?: string;
}

export function AssetIcon({ type, ticker, size = 36, className = "" }: AssetIconProps) {
  const cfg = TYPE_CONFIG[type];
  const label = ticker && ticker !== "—" ? ticker.slice(0, 3) : cfg.letter;
  return (
    <span
      className={["cf-type-icon shrink-0 font-bold select-none", className].filter(Boolean).join(" ")}
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        background: cfg.bg,
        color: cfg.color,
        fontSize: size * 0.36,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        letterSpacing: "-0.02em",
      }}
      title={cfg.label}
    >
      {label}
    </span>
  );
}
