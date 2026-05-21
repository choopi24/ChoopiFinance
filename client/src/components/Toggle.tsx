interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: disabled ? "not-allowed" : "pointer", userSelect: "none" }}>
      {label && <span style={{ fontSize: 14, color: "var(--text-soft)" }}>{label}</span>}
      <button
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={["cf-toggle", checked ? "is-on" : "", disabled ? "is-disabled" : ""].filter(Boolean).join(" ")}
        type="button"
      >
        <span className="cf-toggle-thumb" />
      </button>
    </label>
  );
}
