import type { AssetType } from "@choopi/shared";

const TYPE_CONFIG: Record<AssetType, { label: string; bg: string; color: string; letter: string }> = {
  crypto:    { label: "Crypto",    bg: "var(--c-crypto)",  color: "#fff", letter: "₿" },
  stock:     { label: "Stock",     bg: "var(--c-stocks)",  color: "#fff", letter: "S" },
  etf:       { label: "ETF",       bg: "var(--c-etf)",     color: "#fff", letter: "E" },
  pension:   { label: "Pension",   bg: "var(--c-pension)", color: "#fff", letter: "P" },
  education: { label: "Education", bg: "var(--c-edu)",     color: "#fff", letter: "🎓" },
  other:     { label: "Other",     bg: "var(--c-other)",   color: "#fff", letter: "·" },
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
