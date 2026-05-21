import type { ButtonHTMLAttributes, ReactNode } from "react";

interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  count?: number;
  children: ReactNode;
}

export function Chip({ active, count, children, className = "", ...rest }: ChipProps) {
  return (
    <button
      className={["cf-chip", active ? "is-on" : "", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
      {count !== undefined && (
        <span className="ml-1 opacity-60 text-xs mono">{count}</span>
      )}
    </button>
  );
}
