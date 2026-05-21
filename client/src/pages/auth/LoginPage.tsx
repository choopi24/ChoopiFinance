import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Moon, Sun, Shield, BarChart2, Lock } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../hooks/useTheme";
import { useLanIp } from "../../hooks/useLanIp";
import { Field } from "../../components/Field";
import { PasswordMeter } from "../../components/PasswordMeter";
import { HostPill } from "../../components/HostPill";
import { Button } from "../../components/Button";

type Tab = "signin" | "signup";

const FEATURES = [
  { icon: <BarChart2 size={16} strokeWidth={1.6} />, text: "Track crypto, stocks, ETFs, pension & education funds" },
  { icon: <Shield size={16} strokeWidth={1.6} />,    text: "Your data stays on your machine — no cloud, no telemetry" },
  { icon: <Lock size={16} strokeWidth={1.6} />,      text: "Accessible from any device on your home network" },
];

export default function LoginPage() {
  const [tab, setTab] = useState<Tab>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [lanAck, setLanAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();
  const lanIp = useLanIp();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (tab === "signin") {
        await login(username, password);
      } else {
        await register(username, password);
      }
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const signupBlocked = tab === "signup" && !lanAck;

  return (
    <div className="cf-login">
      {/* Theme toggle */}
      <button
        className="cf-login-theme cf-icon-btn"
        onClick={toggleTheme}
        title="Toggle theme"
        type="button"
      >
        {theme === "light" ? <Moon size={18} strokeWidth={1.6} /> : <Sun size={18} strokeWidth={1.6} />}
      </button>

      <div className="cf-login-grid">
        {/* ── Left panel ── */}
        <div>
          {/* Brand mark */}
          <div
            className="cf-login-mark"
            style={{
              background: "linear-gradient(135deg, var(--grad-from), var(--grad-to))",
              display: "grid",
              placeItems: "center",
              color: "white",
            }}
          >
            <svg viewBox="0 0 56 56" width="34" height="34">
              <defs>
                <linearGradient id="lm-g" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="rgba(255,255,255,0.9)" />
                  <stop offset="100%" stopColor="rgba(255,255,255,0.6)" />
                </linearGradient>
              </defs>
              <rect x="4" y="4" width="48" height="48" rx="14" fill="url(#lm-g)" />
              <path d="M20 36V20a6 6 0 0 1 6-6h8a6 6 0 0 1 6 6" fill="none" stroke="var(--grad-from)" strokeWidth="3.5" strokeLinecap="round" />
              <circle cx="36" cy="36" r="3" fill="var(--grad-from)" />
            </svg>
          </div>

          <h1 className="cf-login-h1 serif">
            Your portfolio,<br />
            <em>your server.</em>
          </h1>

          <p className="cf-login-p">
            Choopi Finance runs entirely on your machine. No accounts, no subscriptions,
            no data leaving your network.
          </p>

          <ul className="cf-login-feats">
            {FEATURES.map((f, i) => (
              <li key={i}>
                <span style={{ color: "var(--grad-from)", flexShrink: 0 }}>{f.icon}</span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        {/* ── Right panel — form card ── */}
        <div className="cf-login-form" style={{ borderRadius: "var(--r-xl)" }}>
          {/* Tab switcher */}
          <div className="cf-login-tabs">
            <button
              type="button"
              className={tab === "signin" ? "is-on" : ""}
              onClick={() => { setTab("signin"); setError(null); }}
            >
              Sign in
            </button>
            <button
              type="button"
              className={tab === "signup" ? "is-on" : ""}
              onClick={() => { setTab("signup"); setError(null); }}
            >
              Create account
            </button>
          </div>

          <form onSubmit={handleSubmit} className="cf-form" autoComplete="off">
            <Field
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. yonatan"
              autoComplete="username"
              autoFocus
            />

            <div>
              <Field
                label="Password"
                password
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tab === "signup" ? "Min 8 characters" : "Your password"}
                autoComplete={tab === "signup" ? "new-password" : "current-password"}
              />
              {tab === "signup" && <PasswordMeter value={password} />}
            </div>

            {/* LAN acknowledgement — signup only */}
            {tab === "signup" && (
              <label className="cf-check" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={lanAck}
                  onChange={(e) => setLanAck(e.target.checked)}
                />
                <span>
                  I understand this instance is reachable from my local network
                  ({lanIp}) and I am the intended user.
                </span>
              </label>
            )}

            {error && (
              <div
                style={{
                  padding: "10px 12px",
                  background: "color-mix(in oklab, var(--rose) 10%, var(--surface))",
                  border: "1px solid color-mix(in oklab, var(--rose) 30%, var(--border))",
                  borderRadius: "var(--r-sm)",
                  color: "var(--rose)",
                  fontSize: 13,
                }}
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              variant="grad"
              fullWidth
              disabled={busy || signupBlocked}
              className="cf-login-cta"
            >
              {busy
                ? (tab === "signin" ? "Signing in…" : "Creating account…")
                : (tab === "signin" ? "Sign in" : "Create account")}
            </Button>

            {tab === "signup" && signupBlocked && (
              <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-faint)", margin: 0 }}>
                Check the LAN acknowledgement box above to continue
              </p>
            )}
          </form>

          {/* HostPill */}
          <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
            <HostPill host={lanIp} />
          </div>
        </div>
      </div>
    </div>
  );
}
