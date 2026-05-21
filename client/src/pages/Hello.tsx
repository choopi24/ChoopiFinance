import { useState } from "react";

export default function Hello() {
  const [dark, setDark] = useState(false);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-10"
      style={{ background: "var(--bg)", transition: "background 0.2s" }}
    >
      {/* Brand glow */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background:
            "radial-gradient(1200px 400px at 80% -10%, rgba(124,58,237,0.10), transparent 60%)",
          pointerEvents: "none",
        }}
      />

      <div className="text-center flex flex-col items-center gap-4 relative">
        {/* Eyebrow */}
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "var(--text-xs)",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontWeight: 600,
            color: "var(--grad-from)",
          }}
        >
          Choopi Finance · scaffold
        </span>

        {/* Hero headline — Instrument Serif italic + brand gradient */}
        <h1
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontWeight: 400,
            fontSize: "clamp(52px, 10vw, 96px)",
            lineHeight: 1.05,
            letterSpacing: "-0.025em",
            margin: 0,
            background:
              "linear-gradient(135deg, var(--grad-from) 0%, var(--grad-mid) 50%, var(--grad-to) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        >
          Hello Choopi
        </h1>

        {/* Mono subline */}
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--text-faint)",
            margin: 0,
            fontFeatureSettings: '"tnum" 1',
          }}
        >
          scaffold ✓ &nbsp;·&nbsp; tailwind v4 ✓ &nbsp;·&nbsp; tokens ✓ &nbsp;·&nbsp; typography ✓
        </p>
      </div>

      {/* Token swatches */}
      <div className="flex gap-2">
        {[
          { bg: "var(--bg)", label: "--bg" },
          { bg: "var(--surface)", label: "--surface", border: "1px solid var(--border)" },
          { bg: "linear-gradient(135deg, var(--grad-from), var(--grad-to))", label: "gradient" },
          { bg: "var(--emerald)", label: "--emerald" },
          { bg: "var(--rose)", label: "--rose" },
        ].map(({ bg, label, border }) => (
          <div key={label} className="flex flex-col items-center gap-1">
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: "var(--r-sm)",
                background: bg,
                border: border ?? "1px solid var(--border)",
              }}
            />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                color: "var(--text-faint)",
              }}
            >
              {label}
            </span>
          </div>
        ))}
      </div>

      {/* Theme toggle */}
      <button
        onClick={toggle}
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "var(--text-sm)",
          fontWeight: 500,
          padding: "8px 16px",
          borderRadius: "var(--r-sm)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
          cursor: "pointer",
          transition: "all 0.15s",
        }}
      >
        Toggle {dark ? "light" : "dark"} mode
      </button>
    </div>
  );
}
