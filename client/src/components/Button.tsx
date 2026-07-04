import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "default" | "primary" | "grad" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconEnd?: ReactNode;
  fullWidth?: boolean;
  children?: ReactNode;
}

const BASE = "inline-flex items-center justify-center gap-2 font-semibold rounded-md transition-all duration-150 cursor-pointer select-none disabled:opacity-45 disabled:cursor-not-allowed disabled:shadow-none";

const VARIANTS: Record<Variant, string> = {
  default: "bg-surface border border-border text-text hover:border-border-strong hover:bg-surface-2",
  primary: "cf-btn-grad",
  grad: "cf-btn-grad",
  danger: "bg-rose text-white border-0 hover:opacity-90",
  ghost: "bg-transparent text-accent-ink border border-accent/40 hover:bg-accent-soft",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-base",
};

export function Button({
  variant = "default",
  size = "md",
  icon,
  iconEnd,
  fullWidth,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={[BASE, VARIANTS[variant], SIZES[size], fullWidth ? "w-full" : "", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
      {iconEnd && <span className="shrink-0">{iconEnd}</span>}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  active?: boolean;
  size?: "sm" | "md";
}

export function IconButton({ children, active, size = "md", className = "", ...rest }: IconButtonProps) {
  const dim = size === "sm" ? "w-7 h-7" : "w-8 h-8";
  return (
    <button
      className={[
        "cf-icon-btn",
        dim,
        active ? "text-text" : "text-text-soft",
        className,
      ].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
