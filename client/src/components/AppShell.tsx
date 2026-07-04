import { useState, useEffect, type ReactNode } from "react";
import type { Currency, Theme } from "@choopi/shared";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { MobileNav } from "./MobileNav";
import { CommandPalette } from "./CommandPalette";
import { StaleDrawer, StaleBanner, useStaleCount } from "./StaleDrawer";

const MOBILE_BP = 768;

interface AppShellProps {
  children: ReactNode;
  theme: Theme;
  onThemeToggle: () => void;
  currency: Currency;
  onCurrencyChange: (c: Currency) => void;
  userName?: string;
  userEmail?: string;
  onLogout?: () => void;
  greeting?: string;
  onAdd?: () => void;
  onImport?: () => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  lastSync?: string | null;
}

export function AppShell({
  children,
  theme,
  onThemeToggle,
  currency,
  onCurrencyChange,
  userName,
  userEmail,
  onLogout,
  greeting,
  onAdd,
  onImport,
  onRefresh,
  isRefreshing,
  lastSync,
}: AppShellProps) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BP);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const staleCount = useStaleCount();

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const topbarProps = {
    theme,
    onThemeToggle,
    currency,
    onCurrencyChange,
    staleCount,
    onSearchClick: () => setPaletteOpen(true),
    onBellClick: () => setDrawerOpen(true),
    onRefresh,
    isRefreshing,
    lastSync,
  };

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAddInvestment={onAdd}
        onImportCsv={onImport}
        onRefresh={onRefresh}
        onToggleTheme={onThemeToggle}
      />
      <StaleDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      {isMobile ? (
        <div className="cf-app is-mobile">
          <header className="cf-mheader">
            <div className="cf-brand">
              <div className="cf-brand-mark" style={{ width: 28, height: 28, fontSize: 13 }}>C</div>
              <span className="cf-brand-name" style={{ fontSize: 15 }}>choopi</span>
            </div>
            <div className="flex items-center gap-2">
              <Topbar {...topbarProps} />
            </div>
          </header>
          <main className="cf-main flex-1 overflow-y-auto">
            <div className="cf-content">{children}</div>
          </main>
          <MobileNav onAdd={onAdd} />
        </div>
      ) : (
        <div className="cf-app is-desktop">
          <Sidebar userName={userName} userEmail={userEmail} onLogout={onLogout} />
          <div className="cf-main flex flex-col min-h-0">
            <Topbar greeting={greeting} {...topbarProps} />
            <div className="cf-content flex-1 overflow-y-auto">
              <StaleBanner onReview={() => setDrawerOpen(true)} />
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
