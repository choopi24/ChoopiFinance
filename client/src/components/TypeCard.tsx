import type { AssetType } from "@choopi/shared";
import { AssetIcon } from "./AssetIcon";

interface TypeCardProps {
  type: AssetType;
  label: string;
  description?: string;
  selected?: boolean;
  onClick?: () => void;
}

export function TypeCard({ type, label, description, selected, onClick }: TypeCardProps) {
  return (
    <button
      type="button"
      className={["cf-type-card", selected ? "is-on" : ""].filter(Boolean).join(" ")}
      onClick={onClick}
    >
      <AssetIcon type={type} size={40} />
      <div className="cf-type-info">
        <div className="cf-type-label">{label}</div>
        {description && <div className="cf-type-desc">{description}</div>}
      </div>
      {selected && (
        <div className="cf-type-check">
          <svg width={16} height={16} viewBox="0 0 16 16">
            <circle cx={8} cy={8} r={8} fill="var(--grad-from)" />
            <path d="M4.5 8l2.5 2.5 4-4" stroke="#fff" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      )}
    </button>
  );
}
