interface PasswordMeterProps {
  value: string;
}

function score(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 8)  s++;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 4);
}

const LABELS = ["", "Weak", "Fair", "Good", "Strong"];
const COLORS = ["", "var(--rose)", "#F59E0B", "#3B82F6", "var(--emerald)"];

export function PasswordMeter({ value }: PasswordMeterProps) {
  const s = score(value);
  return (
    <div className="cf-pw-meter">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="cf-pw-bar">
          <span style={{ width: i <= s ? "100%" : "0%", background: COLORS[s] }} />
        </div>
      ))}
      {value && (
        <span className="cf-pw-hint" style={{ color: COLORS[s] }}>
          {LABELS[s]}
        </span>
      )}
    </div>
  );
}
