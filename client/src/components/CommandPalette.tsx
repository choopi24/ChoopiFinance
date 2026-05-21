import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, LayoutDashboard, TrendingUp, ArrowLeftRight,
  BarChart2, Settings, Plus, Upload, Sun, RefreshCw,
  Bitcoin, LineChart, Globe, Building2, GraduationCap, Package,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = "all" | "investments" | "transactions" | "pages";

interface SearchResult {
  id: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  href?: string;
  action?: () => void;
}

interface SearchData {
  investments: { id: number; name: string; ticker: string | null; type: string }[];
  transactions: { id: number; kind: string; occurred_at: string; total_amount: number; currency: string; investment_name: string }[];
  pages: { id: string; label: string; href: string }[];
}

// ── Local storage recent searches ─────────────────────────────────────────────

const RECENT_KEY = "cf_recent_searches";
const MAX_RECENT = 5;

function getRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}
function pushRecent(q: string) {
  if (!q.trim()) return;
  const prev = getRecent().filter(s => s !== q);
  localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...prev].slice(0, MAX_RECENT)));
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const PAGE_ICONS: Record<string, React.ReactNode> = {
  dashboard:    <LayoutDashboard size={14} />,
  investments:  <TrendingUp size={14} />,
  transactions: <ArrowLeftRight size={14} />,
  realized:     <BarChart2 size={14} />,
  settings:     <Settings size={14} />,
};

const TYPE_ICONS: Record<string, React.ReactNode> = {
  crypto:    <Bitcoin size={14} />,
  stock:     <LineChart size={14} />,
  etf:       <Globe size={14} />,
  pension:   <Building2 size={14} />,
  education: <GraduationCap size={14} />,
  other:     <Package size={14} />,
};

// ── Main component ────────────────────────────────────────────────────────────

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onAddInvestment?: () => void;
  onImportCsv?: () => void;
  onRefresh?: () => void;
  onToggleTheme?: () => void;
}

export function CommandPalette({
  open, onClose, onAddInvestment, onImportCsv, onRefresh, onToggleTheme,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [results, setResults] = useState<SearchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus input on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults(null);
      setTab("all");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim() || q.length < 2) { setResults(null); setLoading(false); return; }
    setLoading(true);
    try {
      const data = await api.get<{ success: true; data: SearchData }>(`/search?q=${encodeURIComponent(q)}`);
      setResults(data.data);
    } catch {
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(query), 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, doSearch]);

  // Build flat item list for keyboard nav
  const items = buildItems(query, results, tab, {
    navigate, onClose, onAddInvestment, onImportCsv, onRefresh, onToggleTheme,
  });

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx(i => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx(i => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && items[activeIdx]) {
        e.preventDefault();
        activateItem(items[activeIdx], query, navigate, onClose);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, activeIdx, items, query, navigate, onClose]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Reset activeIdx on results change
  useEffect(() => { setActiveIdx(0); }, [results, tab]);

  if (!open) return null;

  const recent = getRecent();
  const showEmpty = !query.trim();

  return (
    <div
      className="cf-palette-overlay"
      onClick={onClose}
      role="dialog"
      aria-label="Command palette"
      aria-modal="true"
    >
      <div className="cf-palette" onClick={e => e.stopPropagation()}>

        {/* Search input */}
        <div className="cf-palette-search">
          <Search size={16} strokeWidth={1.6} style={{ color: "var(--text-faint)", flexShrink: 0 }} aria-hidden="true" />
          <input
            ref={inputRef}
            className="cf-palette-input"
            placeholder="Search investments, transactions, pages…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-autocomplete="list"
            aria-activedescendant={items[activeIdx] ? `cf-pal-item-${activeIdx}` : undefined}
          />
          {loading && <span style={{ fontSize: 11, color: "var(--text-faint)", flexShrink: 0 }}>…</span>}
          <kbd className="cf-palette-esc">esc</kbd>
        </div>

        {/* Tabs (only when query has results) */}
        {!showEmpty && results && (
          <div className="cf-palette-tabs" role="tablist">
            {(["all", "investments", "transactions", "pages"] as Tab[]).map(t => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={["cf-palette-tab", tab === t ? "is-active" : ""].filter(Boolean).join(" ")}
                onClick={() => setTab(t)}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t !== "all" && results && (
                  <span className="cf-palette-tab-count">
                    {t === "investments" ? results.investments.length
                      : t === "transactions" ? results.transactions.length
                      : results.pages.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Results list */}
        <ul className="cf-palette-list" role="listbox" ref={listRef}>
          {showEmpty ? (
            <>
              {recent.length > 0 && (
                <>
                  <li className="cf-palette-group-label">Recent searches</li>
                  {recent.map((r, i) => (
                    <li key={i} role="option" aria-selected={activeIdx === i}>
                      <button
                        id={`cf-pal-item-${i}`}
                        className={["cf-palette-item", activeIdx === i ? "is-active" : ""].join(" ")}
                        onClick={() => setQuery(r)}
                      >
                        <Search size={13} style={{ color: "var(--text-faint)" }} aria-hidden="true" />
                        <span>{r}</span>
                      </button>
                    </li>
                  ))}
                </>
              )}
              <li className="cf-palette-group-label">Quick actions</li>
              {QUICK_ACTIONS({ onClose, onAddInvestment, onImportCsv, onRefresh, onToggleTheme, navigate }).map((a, i) => {
                const idx = recent.length + i;
                return (
                  <li key={a.id} role="option" aria-selected={activeIdx === idx}>
                    <button
                      id={`cf-pal-item-${idx}`}
                      className={["cf-palette-item", activeIdx === idx ? "is-active" : ""].join(" ")}
                      onClick={() => activateItem(a, "", navigate, onClose)}
                    >
                      <span className="cf-palette-item-icon" aria-hidden="true">{a.icon}</span>
                      <span>{a.label}</span>
                      {a.sub && <span className="cf-palette-item-sub">{a.sub}</span>}
                    </button>
                  </li>
                );
              })}
            </>
          ) : items.length === 0 && !loading ? (
            <li style={{ padding: "20px 16px", color: "var(--text-faint)", fontSize: 13, textAlign: "center" }}>
              No results for "<strong>{query}</strong>"
            </li>
          ) : (
            items.map((item, i) => (
              <li key={item.id} role="option" aria-selected={activeIdx === i}>
                <button
                  id={`cf-pal-item-${i}`}
                  className={["cf-palette-item", activeIdx === i ? "is-active" : ""].join(" ")}
                  onClick={() => activateItem(item, query, navigate, onClose)}
                >
                  <span className="cf-palette-item-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.sub && <span className="cf-palette-item-sub">{item.sub}</span>}
                </button>
              </li>
            ))
          )}
        </ul>

      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function QUICK_ACTIONS(ctx: {
  onClose: () => void;
  onAddInvestment?: () => void;
  onImportCsv?: () => void;
  onRefresh?: () => void;
  onToggleTheme?: () => void;
  navigate: (href: string) => void;
}): SearchResult[] {
  return [
    ctx.onAddInvestment && {
      id: "qa-add", label: "Add investment", sub: "Open investment form",
      icon: <Plus size={14} />,
      action: () => { ctx.onClose(); ctx.onAddInvestment?.(); },
    },
    ctx.onImportCsv && {
      id: "qa-import", label: "Import CSV", sub: "Bulk import from spreadsheet",
      icon: <Upload size={14} />,
      action: () => { ctx.onClose(); ctx.onImportCsv?.(); },
    },
    ctx.onToggleTheme && {
      id: "qa-theme", label: "Toggle theme", sub: "Switch light / dark",
      icon: <Sun size={14} />,
      action: () => { ctx.onToggleTheme?.(); ctx.onClose(); },
    },
    ctx.onRefresh && {
      id: "qa-refresh", label: "Refresh prices", sub: "Update market data now",
      icon: <RefreshCw size={14} />,
      action: () => { ctx.onRefresh?.(); ctx.onClose(); },
    },
  ].filter(Boolean) as SearchResult[];
}

function buildItems(
  _query: string,
  results: SearchData | null,
  tab: Tab,
  _ctx: {
    navigate: (href: string) => void;
    onClose: () => void;
    onAddInvestment?: () => void;
    onImportCsv?: () => void;
    onRefresh?: () => void;
    onToggleTheme?: () => void;
  }
): SearchResult[] {
  if (!results) return [];
  const items: SearchResult[] = [];

  if (tab === "all" || tab === "investments") {
    results.investments.forEach(inv => {
      items.push({
        id: `inv-${inv.id}`,
        label: inv.name,
        sub: inv.ticker ?? inv.type,
        icon: TYPE_ICONS[inv.type] ?? <TrendingUp size={14} />,
        href: `/investments`,
      });
    });
  }

  if (tab === "all" || tab === "transactions") {
    results.transactions.forEach(tx => {
      items.push({
        id: `tx-${tx.id}`,
        label: tx.investment_name,
        sub: `${tx.kind} · ${tx.occurred_at.slice(0, 10)}`,
        icon: <ArrowLeftRight size={14} />,
        href: `/transactions`,
      });
    });
  }

  if (tab === "all" || tab === "pages") {
    results.pages.forEach(p => {
      items.push({
        id: `pg-${p.id}`,
        label: p.label,
        icon: PAGE_ICONS[p.id] ?? <LayoutDashboard size={14} />,
        href: p.href,
      });
    });
  }

  return items;
}

function activateItem(
  item: SearchResult,
  query: string,
  navigate: (href: string) => void,
  onClose: () => void,
) {
  if (query.trim().length >= 2) pushRecent(query.trim());
  if (item.action) { item.action(); }
  else if (item.href) { navigate(item.href); onClose(); }
}
