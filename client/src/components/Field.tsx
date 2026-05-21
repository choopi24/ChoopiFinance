import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

interface InputPrefixProps { children: ReactNode }
interface InputSuffixProps { children: ReactNode }

export function InputPrefix({ children }: InputPrefixProps) {
  return <span className="cf-input-prefix-el">{children}</span>;
}

export function InputSuffix({ children }: InputSuffixProps) {
  return <span className="cf-input-suffix-el">{children}</span>;
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: string;
  error?: string;
  hint?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  password?: boolean;
}

export function Field({ label, error, hint, prefix, suffix, password, className = "", id, ...rest }: FieldProps) {
  const [show, setShow] = useState(false);
  const inputId = id ?? (label ? label.toLowerCase().replace(/\s+/g, "-") : undefined);

  return (
    <div className={["cf-field", className].filter(Boolean).join(" ")}>
      {label && <label htmlFor={inputId}>{label}</label>}
      <div className={["cf-input-wrap", error ? "has-error" : ""].filter(Boolean).join(" ")}>
        {prefix && <InputPrefix>{prefix}</InputPrefix>}
        <input
          id={inputId}
          type={password && !show ? "password" : rest.type ?? "text"}
          {...rest}
        />
        {password && (
          <button
            type="button"
            className="cf-eye"
            onClick={() => setShow((s) => !s)}
            tabIndex={-1}
          >
            {show ? <EyeOff size={15} strokeWidth={1.6} /> : <Eye size={15} strokeWidth={1.6} />}
          </button>
        )}
        {!password && suffix && <InputSuffix>{suffix}</InputSuffix>}
      </div>
      {error && <div className="cf-field-error">{error}</div>}
      {hint && !error && <div className="cf-field-hint">{hint}</div>}
    </div>
  );
}
