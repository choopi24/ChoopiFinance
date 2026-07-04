import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import { Plus, RotateCw, Eye, EyeOff, Edit2, Trash2, FileText, RefreshCw, Upload, History, TrendingUp, ChevronDown, PlusCircle } from "lucide-react";
import { LineChart } from "../components/LineChart";
import { useInvestmentHistory } from "../hooks/useInvestments";
import { EmptyState } from "../components/EmptyState";
import { CsvImportModal } from "../components/CsvImportModal";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useCurrency } from "../hooks/useCurrency";
import { usePrices } from "../hooks/usePrices";
import { useFxRate } from "../hooks/useFxRate";
import { useInvestments } from "../hooks/useInvestments";
import { toDisplayCurrency, FALLBACK_FX_USD_NIS } from "../hooks/usePortfolio";
import { AppShell } from "../components/AppShell";
import { AssetIcon } from "../components/AssetIcon";
import { Button } from "../components/Button";
import { DeleteConfirmModal } from "../components/DeleteConfirmModal";
import { UpdateBalanceModal } from "../components/UpdateBalanceModal";
import { AddDepositModal } from "../components/AddDepositModal";
import { BackfillModal } from "../components/BackfillModal";
import { SkeletonShimmer } from "../components/SkeletonShimmer";
import { fmt, pct } from "../lib/fmt";
import { ASSET_TYPE_LABELS, type Currency, type AssetType } from "@choopi/shared";
import { TYPE_COLOR_VAR } from "../components/AssetIcon";
import type { Investment } from "../hooks/useInvestments";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FILTER_TYPES: { key: string; label: string }[] = [
  { key: "all",          label: "All" },
  { key: "crypto",       label: "Crypto" },
  { key: "stock",        label: "Stocks" },
  { key: "etf",          label: "ETFs" },
  { key: "pension",      label: "Pension" },
  { key: "gemel",        label: "Gemel" },
  { key: "education",    label: "Study fund" },
  { key: "money_market", label: "Money mkt" },
  { key: "other",        label: "Other" },
];

const MANUAL_TYPES = new Set(["pension", "gemel", "education", "money_market", "other"]);
// Funds that track contributions as DEPOSIT transactions (so new money isn't counted as profit).
const DEPOSIT_TYPES = new Set(["gemel", "education", "money_market", "other"]);

function liquidCountdown(dateStr: string): { text: string; urgent: boolean } {
  const target = new Date(dateStr);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return { text: "Liquidation date passed", urgent: true };
  const days  = Math.floor(diffMs / 86_400_000);
  const months = Math.floor(days / 30);
  const years  = Math.floor(months / 12);
  const remMonths = months % 12;
  const parts: string[] = [];
  if (years > 0)      parts.push(`${years}y`);
  if (remMonths > 0)  parts.push(`${remMonths}mo`);
  if (parts.length === 0) parts.push(`${days}d`);
  const formatted = target.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  return { text: `Liquidates in ${parts.join(" ")} · ${formatted}`, urgent: months < 12 };
}

function relativeDate(iso: string | null): string {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30)  return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ── Sub-line for each row ─────────────────────────────────────────────────────

function InvSubLine({ inv }: { inv: Investment }) {
  if (MANUAL_TYPES.has(inv.type)) {
    if (inv.type === "education" && inv.liquid_date) {
      const { text, urgent } = liquidCountdown(inv.liquid_date);
      return <div className={`cf-inv-sub ${urgent ? "is-amber" : ""}`}>{text}</div>;
    }
    // Linked Israeli fund: value grows from published yields between balance updates.
    if (inv.value_estimated) {
      return (
        <div className="cf-inv-sub" title="Grown from the regulator's published monthly yields since your last balance update">
          Estimated from fund yields · last balance {relativeDate(inv.last_update_at)}
        </div>
      );
    }
    if (inv.stale_days !== null && inv.stale_days >= 30) {
      return (
        <div className="cf-inv-sub is-stale">
          <span className="cf-stale-dot" />
          {inv.stale_days}d since last update · refresh balance
        </div>
      );
    }
    const lastUp = inv.last_update_at ?? inv.created_at;
    return <div className="cf-inv-sub">{relativeDate(lastUp)}</div>;
  }
  // Market types
  const parts: string[] = [];
  if (inv.broker) parts.push(inv.broker);
  if (inv.type === "crypto" && inv.ticker) parts.push("wallet");
  if (inv.etf_kind) parts.push(inv.etf_kind === "accumulating" ? "Acc" : "Dist");
  // No cached live price → valued at cost (e.g. an unpriceable TASE fund).
  const noLivePrice = !inv.closed_at && inv.current_price == null;
  return (
    <div className="cf-inv-sub">
      {parts.join(" · ") || inv.ticker || ""}
      {noLivePrice && <span className="cf-badge-nolive" title="No market price found — valued at cost">no live price</span>}
    </div>
  );
}

// ── Expandable detail panel (graph + clear action buttons) ──────────────────────

interface PanelProps {
  inv: Investment;
  currency: Currency;
  fxRate: number;
  onEdit: (inv: Investment) => void;
  onDelete: (id: number) => void;
  onUpdateBalance: (inv: Investment) => void;
  onAddDeposit: (inv: Investment) => void;
  onBackfill: (inv: Investment) => void;
  onProject: (inv: Investment) => void;
}

function ActButton({
  icon, label, onClick, danger = false, accent = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      className={`cf-inv-act ${danger ? "is-danger" : ""} ${accent ? "is-accent" : ""}`}
      onClick={e => { e.stopPropagation(); onClick(); }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function InvExpandPanel({ inv, currency, fxRate, onEdit, onDelete, onUpdateBalance, onAddDeposit, onBackfill, onProject }: PanelProps) {
  const { data: history, isLoading } = useInvestmentHistory(inv.id, true);
  const isClosed = !!inv.closed_at;
  const isManual = MANUAL_TYPES.has(inv.type);
  const canDeposit = DEPOSIT_TYPES.has(inv.type);

  const series = (history?.points ?? []).map(p => ({
    m: new Date(p.t).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    v: toDisplayCurrency(p.value_nis, currency, fxRate),
  }));

  const first = series[0]?.v ?? 0;
  const last  = series[series.length - 1]?.v ?? 0;
  const change = first > 0 ? ((last - first) / first) * 100 : 0;
  const isPos = change >= 0;

  return (
    <div className="cf-inv-expand" onClick={e => e.stopPropagation()}>
      <div className="cf-inv-expand-chart">
        <div className="cf-inv-expand-head">
          <div className="cf-inv-expand-title">Value over time</div>
          {series.length > 1 && (
            <div className="cf-inv-expand-sub mono" style={{ color: isPos ? "var(--emerald)" : "var(--rose)" }}>
              {isPos ? "+" : ""}{change.toFixed(2)}%
              <span style={{ color: "var(--text-faint)", marginLeft: 6 }}>{fmt(last, { currency })}</span>
            </div>
          )}
        </div>
        {isLoading ? (
          <SkeletonShimmer width="100%" height={180} />
        ) : series.length > 1 ? (
          <LineChart data={series} currency={currency} height={180} gradId={`lc-inv-${inv.id}`} />
        ) : (
          <div className="cf-inv-expand-empty">
            Not enough history yet to chart.{" "}
            {isManual ? "Update the balance over time to build a trend." : "Add transactions or refresh prices to build a trend."}
          </div>
        )}
      </div>

      <div className="cf-inv-act-row">
        {canDeposit && !isClosed && (
          <ActButton accent icon={<PlusCircle size={16} strokeWidth={1.8} />} label="Add deposit" onClick={() => onAddDeposit(inv)} />
        )}
        {isManual && !isClosed && (
          <ActButton accent icon={<RefreshCw size={16} strokeWidth={1.8} />} label="Update balance" onClick={() => onUpdateBalance(inv)} />
        )}
        {!isClosed && (
          <ActButton icon={<History size={16} strokeWidth={1.8} />} label="Backfill history" onClick={() => onBackfill(inv)} />
        )}
        {!isClosed && (
          <ActButton icon={<TrendingUp size={16} strokeWidth={1.8} />} label="Projection" onClick={() => onProject(inv)} />
        )}
        <ActButton icon={<Edit2 size={16} strokeWidth={1.8} />} label="Edit" onClick={() => onEdit(inv)} />
        <ActButton
          icon={<FileText size={16} strokeWidth={1.8} />}
          label="Transactions"
          onClick={() => { window.location.href = `/transactions?investment_id=${inv.id}`; }}
        />
        <ActButton danger icon={<Trash2 size={16} strokeWidth={1.8} />} label="Delete" onClick={() => onDelete(inv.id)} />
      </div>
    </div>
  );
}

// ── Desktop row ───────────────────────────────────────────────────────────────

interface RowProps {
  inv: Investment;
  currency: Currency;
  fxRate: number;
  isExpanded: boolean;
  onToggle: (id: number) => void;
  onEdit: (inv: Investment) => void;
  onDelete: (id: number) => void;
  onUpdateBalance: (inv: Investment) => void;
  onAddDeposit: (inv: Investment) => void;
  onBackfill: (inv: Investment) => void;
  onProject: (inv: Investment) => void;
}

function InvRow({ inv, currency, fxRate, isExpanded, onToggle, onEdit, onDelete, onUpdateBalance, onAddDeposit, onBackfill, onProject }: RowProps) {
  const value   = toDisplayCurrency(inv.current_value_nis, currency, fxRate);
  const cost    = toDisplayCurrency(inv.cost_basis_nis, currency, fxRate);
  const unreal  = toDisplayCurrency(inv.unrealized_pl_nis, currency, fxRate);
  const isPos   = inv.unrealized_pl_nis >= 0;
  const isClosed = !!inv.closed_at;

  return (
    <>
      <tr
        className={`cf-inv-row ${isExpanded ? "is-expanded" : ""} ${isClosed ? "cf-row-closed" : ""}`}
        onClick={() => onToggle(inv.id)}
        aria-expanded={isExpanded}
      >
        <td>
          <div className="cf-inv-name">
            <AssetIcon type={inv.type as AssetType} ticker={inv.ticker ?? undefined} size={34} />
            <div>
              <div className="cf-inv-title">
                {inv.name}
                {isClosed && <span className="cf-badge-closed">Closed</span>}
              </div>
              <InvSubLine inv={inv} />
            </div>
          </div>
        </td>
        <td>
          <span className="cf-type-pill" style={{ color: TYPE_COLOR_VAR[inv.type as AssetType] }}>
            {ASSET_TYPE_LABELS[inv.type as AssetType] ?? inv.type}
          </span>
        </td>
        <td className="mono" style={{ color: "var(--text-soft)", fontSize: 12 }}>
          {isClosed ? "—" : (
            inv.remaining_units > 0
              ? inv.remaining_units.toLocaleString("en-US", { maximumFractionDigits: 6 })
              : "—"
          )}
        </td>
        <td className="mono">{fmt(cost, { currency })}</td>
        <td className="mono">{isClosed ? "—" : fmt(value, { currency })}</td>
        <td>
          {isClosed ? (
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>—</span>
          ) : (
            <div className={`cf-pl ${isPos ? "is-pos" : "is-neg"}`}>
              <span className="cf-pl-abs">{isPos ? "+" : "−"}{fmt(Math.abs(unreal), { currency })}</span>
              {inv.unrealized_pct != null && (
                <span className="cf-pl-pct">{pct(inv.unrealized_pct, { sign: true })}</span>
              )}
            </div>
          )}
        </td>
        <td style={{ fontSize: 12, color: "var(--text-soft)" }}>
          {relativeDate(inv.last_update_at ?? inv.price_cached_at)}
        </td>
        <td>
          <span className="cf-inv-chevron" aria-hidden>
            <ChevronDown size={18} strokeWidth={1.8} />
          </span>
        </td>
      </tr>
      {isExpanded && (
        <tr className="cf-inv-expand-row">
          <td colSpan={8}>
            <InvExpandPanel
              inv={inv}
              currency={currency}
              fxRate={fxRate}
              onEdit={onEdit}
              onDelete={onDelete}
              onUpdateBalance={onUpdateBalance}
              onAddDeposit={onAddDeposit}
              onBackfill={onBackfill}
              onProject={onProject}
            />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Mobile card ───────────────────────────────────────────────────────────────

function InvCard({ inv, currency, fxRate, isExpanded, onToggle, onEdit, onDelete, onUpdateBalance, onAddDeposit, onBackfill, onProject }: RowProps) {
  const value  = toDisplayCurrency(inv.current_value_nis, currency, fxRate);
  const unreal = toDisplayCurrency(inv.unrealized_pl_nis, currency, fxRate);
  const isPos  = inv.unrealized_pl_nis >= 0;
  const isClosed = !!inv.closed_at;

  return (
    <div className={`cf-inv-card-wrap ${isExpanded ? "is-expanded" : ""}`}>
      <div
        className={`cf-inv-card ${isClosed ? "is-closed" : ""}`}
        onClick={() => onToggle(inv.id)}
        aria-expanded={isExpanded}
      >
        <AssetIcon type={inv.type as AssetType} ticker={inv.ticker ?? undefined} size={38} />
        <div className="cf-inv-card-body">
          <div className="cf-inv-card-name">{inv.name}</div>
          <InvSubLine inv={inv} />
        </div>
        <div className="cf-inv-card-right">
          <div className="mono" style={{ fontSize: 14, fontWeight: 500 }}>
            {isClosed ? "—" : fmt(value, { currency })}
          </div>
          {!isClosed && (
            <div className={isPos ? "mono is-pos" : "mono is-neg"} style={{ fontSize: 11, marginTop: 2 }}>
              {isPos ? "+" : "−"}{fmt(Math.abs(unreal), { currency })}
            </div>
          )}
        </div>
        <span className="cf-inv-chevron" aria-hidden>
          <ChevronDown size={18} strokeWidth={1.8} />
        </span>
      </div>
      {isExpanded && (
        <InvExpandPanel
          inv={inv}
          currency={currency}
          fxRate={fxRate}
          onEdit={onEdit}
          onDelete={onDelete}
          onUpdateBalance={onUpdateBalance}
          onAddDeposit={onAddDeposit}
          onBackfill={onBackfill}
          onProject={onProject}
        />
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Investments() {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();
  const { refresh, isRefreshing, lastSync } = usePrices();
  const { data: fx } = useFxRate();

  const [filter, setFilter]           = useState("all");
  const [showClosed, setShowClosed]   = useState(false);
  const [addOpen, setAddOpen]         = useState(false);
  const [csvOpen, setCsvOpen]         = useState(false);
  const [editInv, setEditInv]         = useState<Investment | null>(null);
  const [deleteId, setDeleteId]       = useState<number | null>(null);
  const [balanceInv, setBalanceInv]   = useState<Investment | null>(null);
  const [depositInv, setDepositInv]   = useState<Investment | null>(null);
  const [backfillInv, setBackfillInv] = useState<Investment | null>(null);
  const [expandedId, setExpandedId]   = useState<number | null>(null);
  const toggleExpanded = (id: number) => setExpandedId(cur => (cur === id ? null : id));
  // Track the projection target by id (not a captured object) so the panel always
  // reads the live row — its PV (current_value_nis) then auto-updates after deposits/BUY/UPDATE.
  const [projectionId, setProjectionId] = useState<number | null>(null);

  const { data: investments = [], isLoading } = useInvestments(showClosed);
  // Use live rate from useFxRate → server-embedded rate from enriched investments → documented fallback
  const fxRate = fx?.rate ?? investments[0]?.fx_rate_used ?? FALLBACK_FX_USD_NIS;

  const projectionInv = projectionId != null
    ? investments.find(i => i.id === projectionId) ?? null
    : null;

  // Filter + counts
  const filtered = useMemo(() => {
    return investments.filter(inv => {
      if (!showClosed && inv.closed_at) return false;
      if (filter === "all") return true;
      if (filter === "stock") return inv.type === "stock";
      return inv.type === filter;
    });
  }, [investments, filter, showClosed]);

  const counts = useMemo(() => {
    const base = showClosed ? investments : investments.filter(i => !i.closed_at);
    const counts: Record<string, number> = { all: base.length };
    for (const { key } of FILTER_TYPES) {
      if (key !== "all") counts[key] = base.filter(i => i.type === key).length;
    }
    return counts;
  }, [investments, showClosed]);

  const hour = new Date().getHours();
  const greeting = `${hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening"}, ${user?.username ?? "there"}`;

  return (
    <AppShell
      theme={theme}
      onThemeToggle={toggleTheme}
      currency={currency as Currency}
      onCurrencyChange={setCurrency as (c: Currency) => void}
      userName={user?.username}
      onLogout={logout}
      greeting={greeting}
      onAdd={() => setAddOpen(true)}
      onImport={() => setCsvOpen(true)}
      onRefresh={refresh}
      isRefreshing={isRefreshing}
      lastSync={lastSync}
    >
      {/* Page header */}
      <div className="cf-page-header">
        <div>
          <h1 className="cf-page-title">Investments</h1>
          <p className="cf-page-sub">{counts.all} position{counts.all !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" icon={<Upload size={14} strokeWidth={2} />} onClick={() => setCsvOpen(true)}>Import CSV</Button>
          <Button
            variant="grad"
            size="sm"
            icon={<Plus size={14} strokeWidth={2} />}
            onClick={() => setAddOpen(true)}
          >
            Add Investment
          </Button>
        </div>
      </div>

      {/* Filter + controls row */}
      <div className="cf-filter-row">
        {/* Desktop: underline tabs · Mobile: scroll-pills (Sec. 3j) */}
        <div className="cf-filter-tabs cf-filters-desktop">
          {FILTER_TYPES.map(({ key, label }) => (
            <button
              key={key}
              className={`cf-filter-tab ${filter === key ? "is-on" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
              <span className="cf-tab-count">{counts[key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="cf-chips cf-filters-mobile">
          {FILTER_TYPES.map(({ key, label }) => (
            <button
              key={key}
              className={`cf-chip ${filter === key ? "is-on" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
              <span className="cf-chip-count">{counts[key] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="cf-filter-extras">
          <label className="cf-toggle-label">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={e => setShowClosed(e.target.checked)}
            />
            {showClosed ? <Eye size={13} strokeWidth={1.6} /> : <EyeOff size={13} strokeWidth={1.6} />}
            Closed
          </label>
          <button
            className="cf-icon-btn"
            title="Refresh prices"
            onClick={refresh}
            disabled={isRefreshing}
          >
            <RotateCw
              size={14}
              strokeWidth={1.8}
              style={{ animation: isRefreshing ? "spin 1s linear infinite" : "none" }}
            />
          </button>
        </div>
      </div>

      {/* Table / card list */}
      {isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <SkeletonShimmer width="100%" height={52} />
          <SkeletonShimmer width="100%" height={52} />
          <SkeletonShimmer width="100%" height={52} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="cf-card" style={{ padding: 0 }}>
          <EmptyState
            icon="📭"
            title={filter !== "all" ? `No ${filter} investments` : "No investments yet"}
            description={filter !== "all" ? `Try switching the filter or add a new ${filter} investment.` : "Add your first investment or bulk-import from a spreadsheet."}
            actions={filter !== "all" ? [
              { label: "Add Investment", onClick: () => setAddOpen(true), primary: true },
            ] : [
              { label: "Add Investment", onClick: () => setAddOpen(true), primary: true },
              { label: "Import CSV",     onClick: () => setCsvOpen(true), primary: false },
            ]}
          />
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="cf-table-card cf-inv-table-wrap">
            <table className="cf-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Holding</th>
                  <th scope="col">Cost basis</th>
                  <th scope="col">Current value</th>
                  <th scope="col">Unrealized P/L</th>
                  <th scope="col">Last update</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => (
                  <InvRow
                    key={inv.id}
                    inv={inv}
                    currency={currency as Currency}
                    fxRate={fxRate}
                    isExpanded={expandedId === inv.id}
                    onToggle={toggleExpanded}
                    onEdit={setEditInv}
                    onDelete={setDeleteId}
                    onUpdateBalance={setBalanceInv}
                    onAddDeposit={setDepositInv}
                    onBackfill={setBackfillInv}
                    onProject={inv => setProjectionId(inv.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="cf-inv-cards">
            {filtered.map(inv => (
              <InvCard
                key={inv.id}
                inv={inv}
                currency={currency as Currency}
                fxRate={fxRate}
                isExpanded={expandedId === inv.id}
                onToggle={toggleExpanded}
                onEdit={setEditInv}
                onDelete={setDeleteId}
                onUpdateBalance={setBalanceInv}
                onAddDeposit={setDepositInv}
                onBackfill={setBackfillInv}
                onProject={inv => setProjectionId(inv.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Modals */}
      <DeleteConfirmModal
        investmentId={deleteId}
        onClose={() => setDeleteId(null)}
      />
      <UpdateBalanceModal
        investment={balanceInv}
        onClose={() => setBalanceInv(null)}
      />
      <AddDepositModal
        investment={depositInv}
        currency={currency as Currency}
        fxRate={fxRate}
        onClose={() => setDepositInv(null)}
      />

      {backfillInv && (
        <BackfillModal
          investment={backfillInv}
          onClose={() => setBackfillInv(null)}
        />
      )}

      {projectionInv && (
        <ProjectionPanelLazy
          investment={projectionInv}
          currency={currency as Currency}
          fxRate={fxRate}
          onClose={() => setProjectionId(null)}
        />
      )}

      {/* Add/Edit modal — placeholder until InvestmentModal is ready */}
      {(addOpen || editInv) && (
        <InvestmentModalLazy
          mode={editInv ? "edit" : "add"}
          investment={editInv}
          onClose={() => { setAddOpen(false); setEditInv(null); }}
        />
      )}

      {csvOpen && (
        <CsvImportModal onClose={() => setCsvOpen(false)} />
      )}
    </AppShell>
  );
}

// Lazy-loaded to keep bundle clean
import { lazy, Suspense } from "react";
const InvestmentModalComponent = lazy(() =>
  import("../components/InvestmentModal").then(m => ({ default: m.InvestmentModal }))
);
const ProjectionPanelComponent = lazy(() =>
  import("../components/ProjectionPanel").then(m => ({ default: m.ProjectionPanel }))
);

function ProjectionPanelLazy({
  investment,
  currency,
  fxRate,
  onClose,
}: {
  investment: Investment;
  currency: Currency;
  fxRate: number;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={null}>
      <ProjectionPanelComponent
        investment={investment}
        currency={currency}
        fxRate={fxRate}
        onClose={onClose}
      />
    </Suspense>
  );
}

function InvestmentModalLazy({
  mode,
  investment,
  onClose,
}: {
  mode: "add" | "edit";
  investment: Investment | null;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={null}>
      <InvestmentModalComponent mode={mode} investment={investment} onClose={onClose} />
    </Suspense>
  );
}
