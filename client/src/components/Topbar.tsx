import { useEffect } from "react";
import { Sun, Moon, Bell, Search, RotateCw } from "lucide-react";
import type { Currency, Theme } from "@choopi/shared";
import { Segment } from "./Segment";
import { IconButton } from "./Button";

interface TopbarProps {
  title?: string;
  greeting?: string;
  theme: Theme;
  onThemeToggle: () => void;
  currency: Currency;
  onCurrencyChange: (c: Currency) => void;
  staleCount?: number;
  onSearchClick?: () => void;
  onBellClick?: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  lastSync?: string | null;
}

const CCY_OPTIONS = [
  { value: "NIS" as Currency, label: "₪" },
  { value: "USD" as Currency, label: "$" },
];

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1_000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function Topbar({
  greeting,
  theme,
  onThemeToggle,
  currency,
  onCurrencyChange,
  staleCount = 0,
  onSearchClick,
  onBellClick,
  onRefresh,
  isRefreshing,
  lastSync,
}: TopbarProps) {
  // ⌘K keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onSearchClick?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onSearchClick]);

  return (
    <header className="cf-topbar">
      <div className="cf-greeting">
        {greeting && <div className="cf-greeting-text">{greeting}</div>}
        <div className="cf-greeting-date">{todayLabel()}</div>
      </div>

      <div className="flex items-center gap-2">
        {/* ⌘K search trigger */}
        {onSearchClick && (
          <button className="cf-search-btn" onClick={onSearchClick} title="Search (⌘K)">
            <Search size={13} strokeWidth={1.7} />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>
        )}

        {/* Refresh prices */}
        {onRefresh && (
          <div className="flex items-center gap-1.5">
            {lastSync && !isRefreshing && (
              <span style={{
                fontSize: 11,
                color: "var(--text-faint)",
                fontFamily: "var(--font-mono)",
                whiteSpace: "nowrap",
              }}>
                {timeAgo(lastSync)}
              </span>
            )}
            {isRefreshing && (
              <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>
                syncing…
              </span>
            )}
            <IconButton
              onClick={onRefresh}
              title="Refresh prices"
              disabled={isRefreshing}
              style={{ opacity: isRefreshing ? 0.5 : 1 }}
            >
              <RotateCw
                size={15}
                strokeWidth={1.8}
                style={{ animation: isRefreshing ? "spin 1s linear infinite" : "none" }}
              />
            </IconButton>
          </div>
        )}

        <Segment options={CCY_OPTIONS} value={currency} onChange={onCurrencyChange} size="sm" />

        <IconButton onClick={onThemeToggle} title="Toggle theme">
          {theme === "light" ? <Moon size={16} strokeWidth={1.6} /> : <Sun size={16} strokeWidth={1.6} />}
        </IconButton>

        <div className="relative">
          <IconButton title="Stale positions" onClick={onBellClick}>
            <Bell size={16} strokeWidth={1.6} />
          </IconButton>
          {staleCount > 0 && (
            <span className="cf-dot" title={`${staleCount} stale position${staleCount > 1 ? "s" : ""}`} />
          )}
        </div>
      </div>
    </header>
  );
}
