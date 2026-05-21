import type { ReactNode } from "react";

type PillVariant = "default" | "pos" | "neg" | "neutral";

interface PillProps {
  variant?: PillVariant;
  children: ReactNode;
  className?: string;
}

const VARIANTS: Record<PillVariant, string> = {
  default: "bg-surface-2 text-text-soft border border-border",
  pos: "bg-emerald/10 text-emerald border border-emerald/20",
  neg: "bg-rose/10 text-rose border border-rose/20",
  neutral: "bg-surface-2 text-text-faint border border-border",
};

export function Pill({ variant = "default", children, className = "" }: PillProps) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium mono",
        VARIANTS[variant],
        className,
      ].filter(Boolean).join(" ")}
    >
      {children}
    </span>
  );
}
