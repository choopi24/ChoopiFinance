import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Plus, X, ChevronDown, RefreshCw, Trash2, FileText, CalendarClock, AlertTriangle,
} from "lucide-react";
import { AppShell } from "../components/AppShell";
import { Button } from "../components/Button";
import { Segment } from "../components/Segment";
import { EmptyState } from "../components/EmptyState";
import { SkeletonShimmer } from "../components/SkeletonShimmer";
import { TickerAutocomplete } from "../components/TickerAutocomplete";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useCurrency } from "../hooks/useCurrency";
import { usePrices } from "../hooks/usePrices";
import { useFxRate } from "../hooks/useFxRate";
import { toDisplayCurrency, FALLBACK_FX_USD_NIS } from "../hooks/usePortfolio";
import {
  useRsuGrants, useCreateRsuGrant, useDeleteRsuGrant, useRefreshRsuGrant,
  useAddRsuEvent, useUpdateRsuEvent, useDeleteRsuEvent,
  type RsuGrant, type RsuEvent, type ManualEventInput, type VestingRuleInput,
} from "../hooks/useRsu";
import { fmt, pct } from "../lib/fmt";
import type { Currency } from "@choopi/shared";

// All RSU money uses tabular figures so columns of numbers align.
const TABULAR = { fontVariantNumeric: "tabular-nums" } as const;

function today() { return new Date().toISOString().slice(0, 10); }

function fmtUnits(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function fmtDate(iso: string): string {
  return new Date(iso.slice(0, 10)).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
}

// ── Shared field helper (same shape as InvestmentModal's) ─────────────────────

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="cf-field">
      <label>{label}</label>
      {children}
      {hint && <div className="cf-field-hint" style={{ color: "var(--text-faint)", fontSize: 11 }}>{hint}</div>}
    </div>
  );
}

// ── Vesting event row (inline-editable) ───────────────────────────────────────

function EventRow({ event, currency }: { event: RsuEvent; currency: string }) {
  const [date, setDate]   = useState(event.vest_date.slice(0, 10));
  const [units, setUnits] = useState(String(event.units));
  const [fmv, setFmv]     = useState(event.fmv_at_vest != null ? String(event.fmv_at_vest) : "");
  const updateEvent = useUpdateRsuEvent();
  const deleteEvent = useDeleteRsuEvent();

  const dirty =
    date !== event.vest_date.slice(0, 10) ||
    Number(units) !== event.units ||
    (fmv === "" ? null : Number(fmv)) !== event.fmv_at_vest;

  const isDue = event.status === "scheduled" && date <= today();
  const needsFmv = isDue && fmv === "";

  function save() {
    const body: Partial<ManualEventInput> = {};
    if (date !== event.vest_date.slice(0, 10)) body.vest_date = date;
    if (Number(units) !== event.units) body.units = Number(units);
    if ((fmv === "" ? null : Number(fmv)) !== event.fmv_at_vest) body.fmv_at_vest = fmv === "" ? null : Number(fmv);
    updateEvent.mutate({ eventId: event.id, body });
  }

  return (
    <tr className={event.status === "vested" ? "" : "cf-row-closed"}>
      <td>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          style={{ width: 150, fontSize: 12 }} />
      </td>
      <td>
        <input type="number" min="0" step="any" value={units} onChange={e => setUnits(e.target.value)}
          className="mono" style={{ width: 100, fontSize: 12, ...TABULAR }} />
      </td>
      <td>
        <input type="number" min="0" step="any" value={fmv} onChange={e => setFmv(e.target.value)}
          placeholder="auto" className="mono" style={{ width: 100, fontSize: 12, ...TABULAR }} />
      </td>
      <td className="mono" style={{ fontSize: 12, ...TABULAR }}>
        {event.status === "vested" && event.fmv_at_vest != null
          ? fmt(event.units * event.fmv_at_vest, { currency: currency as Currency })
          : "—"}
      </td>
      <td>
        {event.status === "vested" ? (
          <span className="cf-pill" style={{ color: "var(--emerald)" }}>Vested</span>
        ) : needsFmv ? (
          <span className="cf-pill is-amber" title="Vest date passed but no cost basis — enter the FMV or hit Refresh">
            Needs FMV
          </span>
        ) : (
          <span className="cf-pill" style={{ color: "var(--text-soft)" }}>{isDue ? "Due" : "Scheduled"}</span>
        )}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        {dirty && (
          <Button variant="primary" size="sm" onClick={save} disabled={updateEvent.isPending}>
            {updateEvent.isPending ? "…" : "Save"}
          </Button>
        )}
        <button className="cf-icon-btn" title="Delete event" style={{ marginLeft: 6 }}
          onClick={() => deleteEvent.mutate(event.id)} disabled={deleteEvent.isPending}>
          <Trash2 size={14} strokeWidth={1.6} />
        </button>
      </td>
    </tr>
  );
}

// ── Grant detail (vesting timeline + actions) ─────────────────────────────────

function GrantDetail({ grant, displayCcy, fxRate }: { grant: RsuGrant; displayCcy: Currency; fxRate: number }) {
  const [newDate, setNewDate]   = useState("");
  const [newUnits, setNewUnits] = useState("");
  const [newFmv, setNewFmv]     = useState("");
  const addEvent   = useAddRsuEvent();
  const refresh    = useRefreshRsuGrant();
  const deleteGrant = useDeleteRsuGrant();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const vestedCost = grant.investment
    ? toDisplayCurrency(grant.investment.cost_basis_nis, displayCcy, fxRate)
    : 0;

  return (
    <div className="cf-inv-expand" onClick={e => e.stopPropagation()}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Vesting schedule</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} strokeWidth={1.8} />}
            onClick={() => refresh.mutate(grant.id)} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh vesting"}
          </Button>
          <Button variant="ghost" size="sm" icon={<FileText size={13} strokeWidth={1.8} />}
            onClick={() => { window.location.href = `/transactions?investment_id=${grant.investment_id}`; }}>
            Transactions
          </Button>
          {confirmDelete ? (
            <Button variant="danger" size="sm" onClick={() => deleteGrant.mutate(grant.id)} disabled={deleteGrant.isPending}>
              Confirm delete
            </Button>
          ) : (
            <Button variant="ghost" size="sm" icon={<Trash2 size={13} strokeWidth={1.8} />} onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {grant.due_units > 0 && (
        <div className="cf-quote-preview is-warn" style={{ marginBottom: 10 }}>
          <AlertTriangle size={13} strokeWidth={1.8} style={{ verticalAlign: -2, marginRight: 6 }} />
          {fmtUnits(grant.due_units)} units passed their vest date but aren't booked yet —
          hit <strong>Refresh vesting</strong> to fetch their FMV, or enter it manually below.
        </div>
      )}

      <div className="cf-table-card" style={{ overflow: "auto" }}>
        <table className="cf-table">
          <thead>
            <tr>
              <th scope="col">Vest date</th>
              <th scope="col">Units</th>
              <th scope="col">FMV at vest ({grant.currency})</th>
              <th scope="col">Cost basis</th>
              <th scope="col">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {grant.events.map(e => <EventRow key={`${e.id}-${e.status}-${e.units}-${e.fmv_at_vest}`} event={e} currency={grant.currency} />)}
            {/* Add-event row */}
            <tr>
              <td><input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} style={{ width: 150, fontSize: 12 }} /></td>
              <td><input type="number" min="0" step="any" placeholder="units" value={newUnits} onChange={e => setNewUnits(e.target.value)} className="mono" style={{ width: 100, fontSize: 12, ...TABULAR }} /></td>
              <td><input type="number" min="0" step="any" placeholder="optional" value={newFmv} onChange={e => setNewFmv(e.target.value)} className="mono" style={{ width: 100, fontSize: 12, ...TABULAR }} /></td>
              <td colSpan={2} style={{ fontSize: 11, color: "var(--text-faint)" }}>Add a vesting event</td>
              <td>
                <Button variant="ghost" size="sm" icon={<Plus size={13} strokeWidth={2} />}
                  disabled={!newDate || !newUnits || Number(newUnits) <= 0 || addEvent.isPending}
                  onClick={() => {
                    addEvent.mutate(
                      { grantId: grant.id, body: { vest_date: newDate, units: Number(newUnits), fmv_at_vest: newFmv ? Number(newFmv) : undefined } },
                      { onSuccess: () => { setNewDate(""); setNewUnits(""); setNewFmv(""); } }
                    );
                  }}>
                  Add
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 18, marginTop: 10, fontSize: 12, color: "var(--text-soft)", flexWrap: "wrap" }}>
        <span>Granted <span className="mono" style={TABULAR}>{fmtUnits(grant.total_units)}</span> units on {fmtDate(grant.grant_date)}</span>
        {grant.grant_price != null && (
          <span>FMV at grant <span className="mono" style={TABULAR}>{fmt(grant.grant_price, { currency: grant.currency as Currency, decimals: 2 })}</span> (reference)</span>
        )}
        <span>Vested cost basis <span className="mono" style={TABULAR}>{fmt(vestedCost, { currency: displayCcy })}</span></span>
        {grant.notes && <span dir="auto">{grant.notes}</span>}
      </div>
    </div>
  );
}

// ── Grant card ────────────────────────────────────────────────────────────────

function GrantCard({ grant, displayCcy, fxRate, isExpanded, onToggle }: {
  grant: RsuGrant; displayCcy: Currency; fxRate: number;
  isExpanded: boolean; onToggle: () => void;
}) {
  const inv = grant.investment;
  const value  = inv ? toDisplayCurrency(inv.current_value_nis, displayCcy, fxRate) : 0;
  const unreal = inv ? toDisplayCurrency(inv.unrealized_pl_nis, displayCcy, fxRate) : 0;
  const isPos  = (inv?.unrealized_pl_nis ?? 0) >= 0;
  const vestedPct = grant.total_units > 0 ? (grant.vested_units / grant.total_units) * 100 : 0;

  return (
    <div className={`cf-inv-card-wrap ${isExpanded ? "is-expanded" : ""}`}>
      <div className="cf-inv-card" onClick={onToggle} aria-expanded={isExpanded} style={{ cursor: "pointer" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>{grant.symbol}</span>
            {grant.company_name && <span style={{ fontSize: 12, color: "var(--text-soft)" }}>{grant.company_name}</span>}
            {grant.due_units > 0 && (
              <span className="cf-pill is-amber" style={{ fontSize: 10 }}>
                {fmtUnits(grant.due_units)} due
              </span>
            )}
          </div>
          {/* Vested/unvested split bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <div style={{ flex: 1, maxWidth: 220, height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, vestedPct)}%`, height: "100%", background: "var(--emerald)" }} />
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-soft)", ...TABULAR }}>
              {fmtUnits(grant.vested_units)} / {fmtUnits(grant.total_units)} vested
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
            {grant.next_vest_event ? (
              <>
                <CalendarClock size={11} strokeWidth={1.8} style={{ verticalAlign: -1, marginRight: 4 }} />
                Next vest: {fmtDate(grant.next_vest_event.vest_date)} ·{" "}
                <span className="mono" style={TABULAR}>{fmtUnits(grant.next_vest_event.units)}</span> units
              </>
            ) : "Fully vested"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="mono" style={{ fontSize: 14, fontWeight: 500, ...TABULAR }}>
            {fmt(value, { currency: displayCcy })}
          </div>
          <div className={isPos ? "mono is-pos" : "mono is-neg"} style={{ fontSize: 11, marginTop: 2, ...TABULAR }}>
            {isPos ? "+" : "−"}{fmt(Math.abs(unreal), { currency: displayCcy })}
            {inv?.unrealized_pct != null && <span style={{ marginLeft: 5 }}>{pct(inv.unrealized_pct)}</span>}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }}>vested value · unrealized P/L</div>
        </div>
        <span className="cf-inv-chevron" aria-hidden><ChevronDown size={18} strokeWidth={1.8} /></span>
      </div>
      {isExpanded && <GrantDetail grant={grant} displayCcy={displayCcy} fxRate={fxRate} />}
    </div>
  );
}

// ── New-grant modal ───────────────────────────────────────────────────────────

const FREQ_OPTIONS = [
  { value: "monthly" as const,   label: "Monthly" },
  { value: "quarterly" as const, label: "Quarterly" },
  { value: "annual" as const,    label: "Annual" },
];
const MODE_OPTIONS = [
  { value: "rule" as const,   label: "Generate schedule" },
  { value: "manual" as const, label: "Manual events" },
];
const CCY_OPTIONS = [
  { value: "USD" as Currency, label: "$ USD" },
  { value: "NIS" as Currency, label: "₪ NIS" },
];

interface DraftEvent { _id: string; vest_date: string; units: string; fmv: string }

function NewGrantModal({ onClose }: { onClose: () => void }) {
  const [symbol, setSymbol]       = useState("");
  const [company, setCompany]     = useState("");
  const [grantDate, setGrantDate] = useState(today());
  const [totalUnits, setTotal]    = useState("");
  const [grantPrice, setPrice]    = useState("");
  const [currency, setCurrency]   = useState<Currency>("USD");
  const [notes, setNotes]         = useState("");
  const [mode, setMode]           = useState<"rule" | "manual">("rule");
  // Rule mode
  const [cliff, setCliff]         = useState("12");
  const [totalMonths, setMonths]  = useState("48");
  const [frequency, setFrequency] = useState<VestingRuleInput["frequency"]>("monthly");
  // Manual mode
  const [rows, setRows]           = useState<DraftEvent[]>([
    { _id: crypto.randomUUID(), vest_date: "", units: "", fmv: "" },
  ]);
  const [error, setError]         = useState<string | null>(null);

  const createGrant = useCreateRsuGrant();

  const manualSum = useMemo(
    () => rows.reduce((s, r) => s + (Number(r.units) || 0), 0),
    [rows]
  );
  const totalNum = Number(totalUnits) || 0;

  function submit() {
    setError(null);
    if (!symbol.trim())            { setError("Symbol is required"); return; }
    if (!grantDate)                { setError("Grant date is required"); return; }
    if (!(totalNum > 0))           { setError("Total units must be a positive number"); return; }

    const body = {
      symbol: symbol.trim().toUpperCase(),
      company_name: company.trim() || undefined,
      grant_date: grantDate,
      total_units: totalNum,
      grant_price: grantPrice ? Number(grantPrice) : undefined,
      currency,
      notes: notes.trim() || undefined,
    };

    if (mode === "rule") {
      const rule: VestingRuleInput = {
        cliff_months: Number(cliff) || 0,
        total_months: Number(totalMonths),
        frequency,
      };
      if (!(rule.total_months >= 1)) { setError("Vesting period (months) is required"); return; }
      createGrant.mutate({ ...body, rule }, { onSuccess: onClose, onError: e => setError(e.message) });
    } else {
      const events = rows
        .filter(r => r.vest_date && Number(r.units) > 0)
        .map(r => ({ vest_date: r.vest_date, units: Number(r.units), fmv_at_vest: r.fmv ? Number(r.fmv) : undefined }));
      if (events.length === 0) { setError("Add at least one vesting event"); return; }
      if (Math.abs(manualSum - totalNum) > 1e-6) {
        setError(`Event units sum to ${fmtUnits(manualSum)} but total is ${fmtUnits(totalNum)} — they must match`);
        return;
      }
      createGrant.mutate({ ...body, events }, { onSuccess: onClose, onError: e => setError(e.message) });
    }
  }

  return createPortal(
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div className="cf-modal" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="cf-modal-head">
          <div>
            <div className="cf-modal-step">RSU</div>
            <div className="cf-modal-title">New grant</div>
          </div>
          <button className="cf-icon-btn" onClick={onClose} title="Close"><X size={16} strokeWidth={1.6} /></button>
        </div>

        {error && <div className="cf-modal-error">{error}</div>}

        <div className="cf-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Stock symbol" hint="Type to search">
              <TickerAutocomplete
                type="stock" value={symbol} onChange={setSymbol}
                onSelect={h => { setSymbol(h.symbol.toUpperCase()); if (!company.trim()) setCompany(h.name); }}
                placeholder="NVDA, MSFT…" autoFocus
              />
            </Field>
            <Field label="Company (optional)">
              <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Auto-filled from search" />
            </Field>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Grant date">
              <input type="date" value={grantDate} max={today()} onChange={e => setGrantDate(e.target.value)} />
            </Field>
            <Field label="Total units granted">
              <input type="number" min="0" step="any" value={totalUnits} onChange={e => setTotal(e.target.value)}
                placeholder="e.g. 4800" className="mono" style={TABULAR} />
            </Field>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="FMV at grant (optional)" hint="Reference only — cost basis comes from FMV at each vest">
              <input type="number" min="0" step="any" value={grantPrice} onChange={e => setPrice(e.target.value)}
                placeholder="—" className="mono" style={TABULAR} />
            </Field>
            <Field label="Currency">
              <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
            </Field>
          </div>

          <Field label="Vesting">
            <Segment options={MODE_OPTIONS} value={mode} onChange={setMode} />
          </Field>

          {mode === "rule" ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <Field label="Cliff (months)" hint="0 = no cliff">
                  <input type="number" min="0" step="1" value={cliff} onChange={e => setCliff(e.target.value)} />
                </Field>
                <Field label="Total period (months)">
                  <input type="number" min="1" step="1" value={totalMonths} onChange={e => setMonths(e.target.value)} />
                </Field>
                <Field label="Frequency">
                  <select className="cf-select" value={frequency}
                    onChange={e => setFrequency(e.target.value as VestingRuleInput["frequency"])}>
                    {FREQ_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </Field>
              </div>
              <div className="cf-quote-preview">
                Generates discrete vesting events{Number(cliff) > 0 && <> — first tranche at the {cliff}-month cliff</>},
                then {frequency} until month {totalMonths || "…"}. Every event stays editable after creation,
                and any rounding remainder lands in the final event so units always sum to the total.
              </div>
            </>
          ) : (
            <div>
              {rows.map(row => (
                <div key={row._id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, marginBottom: 8, alignItems: "end" }}>
                  <Field label="Vest date">
                    <input type="date" value={row.vest_date}
                      onChange={e => setRows(rs => rs.map(r => r._id === row._id ? { ...r, vest_date: e.target.value } : r))} />
                  </Field>
                  <Field label="Units">
                    <input type="number" min="0" step="any" value={row.units} className="mono" style={TABULAR}
                      onChange={e => setRows(rs => rs.map(r => r._id === row._id ? { ...r, units: e.target.value } : r))} />
                  </Field>
                  <Field label="FMV at vest (optional)">
                    <input type="number" min="0" step="any" value={row.fmv} placeholder="auto-fetch" className="mono" style={TABULAR}
                      onChange={e => setRows(rs => rs.map(r => r._id === row._id ? { ...r, fmv: e.target.value } : r))} />
                  </Field>
                  <button className="cf-icon-btn" style={{ marginBottom: 2, color: "var(--rose)" }} title="Remove"
                    onClick={() => setRows(rs => rs.filter(r => r._id !== row._id))}>
                    <Trash2 size={14} strokeWidth={1.6} />
                  </button>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Button variant="ghost" size="sm" icon={<Plus size={13} strokeWidth={2} />}
                  onClick={() => setRows(rs => [...rs, { _id: crypto.randomUUID(), vest_date: "", units: "", fmv: "" }])}>
                  Add event
                </Button>
                <span className="mono" style={{ fontSize: 12, ...TABULAR, color: Math.abs(manualSum - totalNum) < 1e-6 ? "var(--emerald)" : "var(--amber)" }}>
                  {fmtUnits(manualSum)} / {fmtUnits(totalNum)} units
                </span>
              </div>
            </div>
          )}

          <Field label="Notes (optional)">
            <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Grant ID, employer, ESPP batch…" />
          </Field>

          <div className="cf-modal-actions" style={{ marginTop: 4 }}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={submit} disabled={createGrant.isPending}>
              {createGrant.isPending ? "Creating…" : "Add grant"}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RsuGrants() {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();
  const { refresh, isRefreshing, lastSync } = usePrices();
  const { data: fx } = useFxRate();

  const { data: grants = [], isLoading } = useRsuGrants();
  const [addOpen, setAddOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const fxRate = fx?.rate ?? grants[0]?.investment?.fx_rate_used ?? FALLBACK_FX_USD_NIS;
  const displayCcy = currency as Currency;

  const totals = useMemo(() => {
    let value = 0, unrealized = 0, unvested = 0;
    for (const g of grants) {
      value += g.investment?.current_value_nis ?? 0;
      unrealized += g.investment?.unrealized_pl_nis ?? 0;
      unvested += g.unvested_units;
    }
    return { value, unrealized, unvested };
  }, [grants]);

  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${user?.username ?? "there"}`;

  return (
    <AppShell
      theme={theme}
      onThemeToggle={toggleTheme}
      currency={displayCcy}
      onCurrencyChange={setCurrency as (c: Currency) => void}
      userName={user?.username}
      onLogout={logout}
      greeting={greeting}
      onAdd={() => setAddOpen(true)}
      onRefresh={refresh}
      isRefreshing={isRefreshing}
      lastSync={lastSync}
    >
      <div className="cf-page-header">
        <div>
          <h1 className="cf-page-title">RSU Grants</h1>
          <p className="cf-page-sub">
            {grants.length} grant{grants.length !== 1 ? "s" : ""}
            {grants.length > 0 && (
              <>
                {" · "}vested value{" "}
                <span className="mono" style={TABULAR}>
                  {fmt(toDisplayCurrency(totals.value, displayCcy, fxRate), { currency: displayCcy })}
                </span>
                {" · "}
                <span className={`mono ${totals.unrealized >= 0 ? "is-pos" : "is-neg"}`} style={TABULAR}>
                  {totals.unrealized >= 0 ? "+" : "−"}
                  {fmt(Math.abs(toDisplayCurrency(totals.unrealized, displayCcy, fxRate)), { currency: displayCcy })}
                </span>
                {" unrealized · "}
                <span className="mono" style={TABULAR}>{fmtUnits(totals.unvested)}</span> units unvested
              </>
            )}
          </p>
        </div>
        <Button variant="grad" size="sm" icon={<Plus size={14} strokeWidth={2} />} onClick={() => setAddOpen(true)}>
          Add Grant
        </Button>
      </div>

      {isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <SkeletonShimmer width="100%" height={74} />
          <SkeletonShimmer width="100%" height={74} />
        </div>
      ) : grants.length === 0 ? (
        <div className="cf-card" style={{ padding: 0 }}>
          <EmptyState
            icon="📜"
            title="No RSU grants yet"
            description="Record a grant with its vesting schedule — vested units are valued live and count toward your net worth."
            actions={[{ label: "Add Grant", onClick: () => setAddOpen(true), primary: true }]}
          />
        </div>
      ) : (
        <div className="cf-inv-cards" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {grants.map(g => (
            <GrantCard
              key={g.id}
              grant={g}
              displayCcy={displayCcy}
              fxRate={fxRate}
              isExpanded={expandedId === g.id}
              onToggle={() => setExpandedId(cur => (cur === g.id ? null : g.id))}
            />
          ))}
        </div>
      )}

      {addOpen && <NewGrantModal onClose={() => setAddOpen(false)} />}
    </AppShell>
  );
}
