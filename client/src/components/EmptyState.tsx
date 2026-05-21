import type { ReactNode } from "react";

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

interface EmptyStateProps {
  icon?: ReactNode | string;
  title: string;
  description?: string;
  /** Legacy single-action prop */
  action?: { label: string; onClick: () => void };
  /** Multi-action variant */
  actions?: EmptyStateAction[];
}

export function EmptyState({ icon, title, description, action, actions }: EmptyStateProps) {
  const allActions: EmptyStateAction[] = actions ?? (action ? [{ ...action, primary: true }] : []);

  return (
    <div className="cf-empty-state" role="status">
      {icon && (
        <div className="cf-empty-icon" aria-hidden="true">
          {typeof icon === "string" ? icon : (
            <div style={{ color: "var(--text-faint)" }}>{icon}</div>
          )}
        </div>
      )}
      <div className="cf-empty-title">{title}</div>
      {description && <div className="cf-empty-body">{description}</div>}
      {allActions.length > 0 && (
        <div className="cf-empty-actions">
          {allActions.map((a, i) => (
            <button
              key={i}
              className={a.primary ? "cf-btn cf-btn-grad" : "cf-btn cf-btn-secondary"}
              onClick={a.onClick}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
