import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useCurrency } from "../hooks/useCurrency";
import { useFxRate, useSettings as useFxSettings, useFxOverride } from "../hooks/useFxRate";
import { useLanIp } from "../hooks/useLanIp";
import {
  useUserSettings, useUpdateDisplayName, useChangePassword,
  useUpdatePreferences, useTriggerSnapshot, useResetData,
} from "../hooks/useSettings";
import { AppShell } from "../components/AppShell";
import { PasswordMeter } from "../components/PasswordMeter";
import { CsvImportModal } from "../components/CsvImportModal";
import type { Currency } from "@choopi/shared";
import {
  User, Palette, Database, Zap, Info,
  ChevronRight, Eye, EyeOff, Copy, Check,
} from "lucide-react";

// ── SettingRow ────────────────────────────────────────────────────────────────

function SectionCard({ title, icon, children }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="cf-card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="cf-settings-section-head">
        {icon}
        <span>{title}</span>
      </div>
      <div className="cf-settings-rows">{children}</div>
    </div>
  );
}

function SettingRow({ label, sub, children }: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="cf-setting-row">
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>{sub}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="cf-toggle-label">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
      />
      <div className={["cf-toggle", checked ? "is-on" : ""].join(" ")} />
    </label>
  );
}

function Segment({ options, value, onChange }: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="cf-segment">
      {options.map(o => (
        <button
          key={o.id}
          className={["cf-segment-btn", value === o.id ? "is-active" : ""].join(" ")}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Profile section ───────────────────────────────────────────────────────────

function ProfileSection({ username }: { username: string }) {
  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);

  const { data: settings } = useUserSettings();
  const updateName = useUpdateDisplayName();
  const changePw = useChangePassword();

  const storedName = settings?.display_name ?? "";

  async function saveName() {
    await updateName.mutateAsync(displayName || null);
    setEditingName(false);
  }

  async function savePassword() {
    setPwError("");
    setPwSuccess(false);
    if (newPw !== confirmPw) { setPwError("Passwords do not match"); return; }
    if (newPw.length < 8) { setPwError("New password must be at least 8 characters"); return; }
    try {
      await changePw.mutateAsync({ current_password: currentPw, new_password: newPw });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
      setPwSuccess(true);
      setTimeout(() => setPwSuccess(false), 3000);
    } catch (e) {
      setPwError((e as Error).message);
    }
  }

  return (
    <SectionCard title="Profile" icon={<User size={15} />}>
      <SettingRow label="Username" sub="Cannot be changed">
        <span style={{ fontFamily: "monospace", fontSize: 13 }}>{username}</span>
      </SettingRow>

      <SettingRow label="Display name" sub="Shown in the greeting and sidebar">
        {editingName ? (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="cf-input"
              style={{ width: 160 }}
              placeholder={username}
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              autoFocus
            />
            <button className="cf-btn cf-btn-primary" onClick={saveName} disabled={updateName.isPending}>
              {updateName.isPending ? "…" : "Save"}
            </button>
            <button className="cf-btn cf-btn-ghost" onClick={() => setEditingName(false)}>Cancel</button>
          </div>
        ) : (
          <button className="cf-btn cf-btn-ghost" onClick={() => { setDisplayName(storedName); setEditingName(true); }}>
            {storedName || username} <ChevronRight size={13} />
          </button>
        )}
      </SettingRow>

      {/* Password change */}
      <div className="cf-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Change password</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 360 }}>
          <div style={{ position: "relative" }}>
            <input
              className="cf-input"
              type={showPw ? "text" : "password"}
              placeholder="Current password"
              value={currentPw}
              onChange={e => setCurrentPw(e.target.value)}
              style={{ width: "100%", paddingRight: 36 }}
            />
            <button
              onClick={() => setShowPw(s => !s)}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)" }}
            >
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <input
            className="cf-input"
            type={showPw ? "text" : "password"}
            placeholder="New password (min 8 chars)"
            value={newPw}
            onChange={e => setNewPw(e.target.value)}
            style={{ width: "100%" }}
          />
          <PasswordMeter value={newPw} />
          <input
            className="cf-input"
            type={showPw ? "text" : "password"}
            placeholder="Confirm new password"
            value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)}
            style={{ width: "100%" }}
          />
          {pwError && <div className="cf-modal-error">{pwError}</div>}
          {pwSuccess && <div style={{ fontSize: 12, color: "var(--emerald)" }}>Password changed successfully</div>}
          <button
            className="cf-btn cf-btn-primary"
            style={{ alignSelf: "flex-start" }}
            disabled={!currentPw || !newPw || !confirmPw || changePw.isPending}
            onClick={savePassword}
          >
            {changePw.isPending ? "Saving…" : "Update password"}
          </button>
        </div>
      </div>
    </SectionCard>
  );
}

// ── Preferences section ───────────────────────────────────────────────────────

function PreferencesSection() {
  const [, , themeMode, setThemeMode] = useTheme();
  const [currency, setCurrency] = useCurrency();
  const { data: fxData } = useFxRate();
  const { data: settingsData } = useFxSettings();
  const fxOverride = useFxOverride();
  const { data: userSettings } = useUserSettings();
  const updatePrefs = useUpdatePreferences();

  const overrideOn = settingsData?.fx_override != null;
  const [overrideInput, setOverrideInput] = useState(
    settingsData?.fx_override?.toString() ?? "3.72"
  );
  const liveRate = fxData?.rate?.toFixed(4) ?? "…";

  function toggleFxOverride(on: boolean) {
    if (on) {
      const n = parseFloat(overrideInput);
      if (!isNaN(n) && n > 0) fxOverride.mutate(n);
    } else {
      fxOverride.mutate(null);
    }
  }

  return (
    <SectionCard title="Preferences" icon={<Palette size={15} />}>
      <SettingRow label="Display currency">
        <Segment
          options={[{ id: "NIS", label: "₪ NIS" }, { id: "USD", label: "$ USD" }]}
          value={currency}
          onChange={v => setCurrency(v as Currency)}
        />
      </SettingRow>

      <SettingRow label="Theme">
        <Segment
          options={[
            { id: "system", label: "System" },
            { id: "light",  label: "Light"  },
            { id: "dark",   label: "Dark"   },
          ]}
          value={themeMode}
          onChange={v => setThemeMode(v as any)}
        />
      </SettingRow>

      <div className="cf-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>FX rate override</div>
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
              Live rate: 1 USD = {liveRate} NIS
            </div>
          </div>
          <Toggle checked={overrideOn} onChange={toggleFxOverride} />
        </div>
        {overrideOn && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 260 }}>
            <span style={{ fontSize: 12, color: "var(--text-faint)", whiteSpace: "nowrap" }}>1 USD =</span>
            <input
              className="cf-input"
              type="number"
              step="0.01"
              min="0.01"
              max="100"
              value={overrideInput}
              onChange={e => setOverrideInput(e.target.value)}
              style={{ width: 90 }}
            />
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>NIS</span>
            <button
              className="cf-btn cf-btn-primary"
              onClick={() => { const n = parseFloat(overrideInput); if (!isNaN(n) && n > 0) fxOverride.mutate(n); }}
            >
              Apply
            </button>
          </div>
        )}
      </div>

      <SettingRow
        label="Stay signed in"
        sub="Extends session to 90 days · Takes effect on next login"
      >
        <Toggle
          checked={Boolean(userSettings?.stay_signed_in)}
          onChange={v => updatePrefs.mutate({ stay_signed_in: v })}
        />
      </SettingRow>

      <SettingRow
        label="Show portfolio on lock screen"
        sub="Skip password step · PIN re-prompt every 24h"
      >
        <Toggle
          checked={Boolean(userSettings?.show_on_lock_screen)}
          onChange={v => updatePrefs.mutate({ show_on_lock_screen: v })}
        />
      </SettingRow>
    </SectionCard>
  );
}

// ── Data section ──────────────────────────────────────────────────────────────

function DataSection({ onOpenImport }: { onOpenImport: () => void }) {
  const snapshot = useTriggerSnapshot();
  const resetData = useResetData();
  const [resetStep, setResetStep] = useState<0 | 1 | 2>(0);
  const [snapshotDone, setSnapshotDone] = useState(false);

  async function doSnapshot() {
    await snapshot.mutateAsync();
    setSnapshotDone(true);
    setTimeout(() => setSnapshotDone(false), 2500);
  }

  function downloadExport() {
    const a = document.createElement("a");
    a.href = "/api/settings/export";
    a.download = `choopi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  async function confirmReset() {
    await resetData.mutateAsync();
    setResetStep(0);
  }

  return (
    <SectionCard title="Data" icon={<Database size={15} />}>
      <SettingRow label="Export all data" sub="Full JSON backup of your ledger">
        <button className="cf-btn cf-btn-ghost" onClick={downloadExport}>
          Download JSON
        </button>
      </SettingRow>

      <SettingRow label="Import from CSV" sub="Bulk-add investments from a spreadsheet">
        <button className="cf-btn cf-btn-ghost" onClick={onOpenImport}>
          Import CSV
        </button>
      </SettingRow>

      <SettingRow
        label="Snapshot now"
        sub="Record current portfolio value in history"
      >
        <button
          className="cf-btn cf-btn-ghost"
          onClick={doSnapshot}
          disabled={snapshot.isPending}
        >
          {snapshotDone ? <><Check size={13} /> Done</> : snapshot.isPending ? "Snapping…" : "Take snapshot"}
        </button>
      </SettingRow>

      <div className="cf-setting-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: "var(--rose)" }}>Reset all data</div>
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
              Permanently deletes all investments and transactions
            </div>
          </div>
          {resetStep === 0 && (
            <button className="cf-btn cf-btn-danger" onClick={() => setResetStep(1)}>
              Reset…
            </button>
          )}
        </div>
        {resetStep === 1 && (
          <div style={{ padding: "12px 14px", background: "color-mix(in oklab, var(--rose) 10%, transparent)", borderRadius: 8, border: "1px solid color-mix(in oklab, var(--rose) 30%, transparent)" }}>
            <p style={{ margin: "0 0 12px", fontSize: 13 }}>
              This will permanently delete <strong>all investments, transactions, and portfolio history</strong>. Your account will remain. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="cf-btn cf-btn-ghost" onClick={() => setResetStep(0)}>Cancel</button>
              <button className="cf-btn cf-btn-danger" onClick={() => setResetStep(2)}>
                I understand, continue
              </button>
            </div>
          </div>
        )}
        {resetStep === 2 && (
          <div style={{ padding: "12px 14px", background: "color-mix(in oklab, var(--rose) 10%, transparent)", borderRadius: 8, border: "1px solid color-mix(in oklab, var(--rose) 30%, transparent)" }}>
            <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
              Are you absolutely sure? This is irreversible.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="cf-btn cf-btn-ghost" onClick={() => setResetStep(0)}>Cancel</button>
              <button
                className="cf-btn cf-btn-danger"
                onClick={confirmReset}
                disabled={resetData.isPending}
              >
                {resetData.isPending ? "Deleting…" : "Yes, delete everything"}
              </button>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

function IntegrationsSection() {
  return (
    <SectionCard title="Integrations" icon={<Zap size={15} />}>
      <div className="cf-setting-row cf-integration-card">
        <div style={{ fontSize: 28 }}>💬</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>WhatsApp bot</span>
            <span className="cf-badge-soon">Soon</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
            Update investments by texting your private bot. Coming later.
          </div>
        </div>
      </div>
      <div className="cf-setting-row cf-integration-card">
        <div style={{ fontSize: 28 }}>🤖</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Anthropic Claude</span>
            <span className="cf-badge-soon">Soon</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
            Natural language queries over your portfolio. Powered by Claude.
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ── About section ─────────────────────────────────────────────────────────────

function AboutSection() {
  const lanIp = useLanIp();
  const [copied, setCopied] = useState(false);

  function copyIp() {
    navigator.clipboard.writeText(`http://${lanIp}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <SectionCard title="About" icon={<Info size={15} />}>
      <SettingRow label="Version" sub="Choopi Finance">
        <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-faint)" }}>0.1.0</span>
      </SettingRow>

      <SettingRow label="LAN address" sub="Access from phone or tablet on your network">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <code style={{ fontSize: 12, background: "var(--surface-2)", padding: "3px 8px", borderRadius: 6 }}>
            http://{lanIp}
          </code>
          <button
            className="cf-icon-btn"
            onClick={copyIp}
            title="Copy"
          >
            {copied ? <Check size={13} style={{ color: "var(--emerald)" }} /> : <Copy size={13} />}
          </button>
        </div>
      </SettingRow>

      <SettingRow label="Find your IP" sub="macOS: System Settings → Wi-Fi → Details · Windows: ipconfig in terminal">
        <span />
      </SettingRow>
    </SectionCard>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();
  const [csvOpen, setCsvOpen] = useState(false);

  return (
    <AppShell
      theme={theme}
      onThemeToggle={toggleTheme}
      currency={currency as Currency}
      onCurrencyChange={c => setCurrency(c)}
      userName={user?.username}
      onLogout={logout}
    >
      <div className="cf-page-header">
        <div>
          <h1 className="cf-page-title">Settings</h1>
          <p className="cf-page-sub">Manage your account, preferences, and data</p>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
        <ProfileSection username={user?.username ?? ""} />
        <PreferencesSection />
        <DataSection onOpenImport={() => setCsvOpen(true)} />
        <IntegrationsSection />
        <AboutSection />
      </div>

      {csvOpen && <CsvImportModal onClose={() => setCsvOpen(false)} />}
    </AppShell>
  );
}
