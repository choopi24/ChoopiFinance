import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  pad?: boolean;
}

export function Card({ children, pad = true, className = "", ...rest }: CardProps) {
  return (
    <div className={["cf-card", pad ? "p-5" : "", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </div>
  );
}

interface CardHeadProps {
  title: string;
  sub?: string;
  action?: ReactNode;
}

export function CardHead({ title, sub, action }: CardHeadProps) {
  return (
    <div className="cf-card-head">
      <div>
        <div className="cf-card-title">{title}</div>
        {sub && <div className="cf-card-sub">{sub}</div>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}
