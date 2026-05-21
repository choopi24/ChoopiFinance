import type { ReactNode } from "react";

interface SettingRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  danger?: boolean;
}

export function SettingRow({ label, description, children, danger }: SettingRowProps) {
  return (
    <div className={["cf-setting-row", danger ? "is-danger" : ""].filter(Boolean).join(" ")}>
      <div className="cf-setting-text">
        <div className={["cf-setting-label", danger ? "text-rose" : ""].filter(Boolean).join(" ")}>
          {label}
        </div>
        {description && (
          <div className="cf-setting-desc">{description}</div>
        )}
      </div>
      <div className="cf-setting-control">{children}</div>
    </div>
  );
}
