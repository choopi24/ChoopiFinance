import { useAuth } from "../context/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useCurrency } from "../hooks/useCurrency";
import { usePortfolio, toDisplayCurrency, FALLBACK_FX_USD_NIS } from "../hooks/usePortfolio";
import { usePrices } from "../hooks/usePrices";
import { useFxRate } from "../hooks/useFxRate";
import { useRecentTransactions } from "../hooks/useTransactions";
import { AppShell } from "../components/AppShell";
import { KpiHero } from "../components/KpiHero";
import { ChartCard } from "../components/ChartCard";
import { AllocationCard } from "../components/AllocationCard";
import { ActivityList } from "../components/ActivityList";
import { WelcomeState } from "../components/WelcomeState";
import { SkeletonShimmer } from "../components/SkeletonShimmer";
import type { Currency } from "@choopi/shared";

const TYPE_COLORS: Record<string, string> = {
  crypto:    "var(--c-crypto, #7C3AED)",
  stock:     "var(--c-stocks, #0EA5E9)",
  etf:       "var(--c-etf, #14B8A6)",
  pension:   "var(--c-pension, #F59E0B)",
  education: "var(--c-edu, #EC4899)",
  other:     "var(--c-other, #94A3B8)",
};
const CCY_COLORS: Record<string, string> = {
  NIS: "#7C3AED",
  USD: "#F472B6",
};

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();
  const { refresh, isRefreshing, lastSync } = usePrices();
  const { data: fx } = useFxRate();
  const { data: portfolio, isLoading: portfolioLoading } = usePortfolio();
  const { data: recentTxs = [] } = useRecentTransactions(5);

  const fxRate = fx?.rate ?? portfolio?.fx_rate_used ?? FALLBACK_FX_USD_NIS;

  // ── Derive display values ─────────────────────────────────────────────────
  const totalValueNis  = portfolio?.total_value_nis ?? 0;
  const totalValueAlt  = currency === "NIS"
    ? (fxRate > 0 ? totalValueNis / fxRate : 0)
    : totalValueNis;
  const netInvestedNis = portfolio?.total_net_deposited_nis ?? 0;
  const unrealizedNis  = portfolio?.unrealized_pl_nis ?? 0;
  const unrealizedPct  = portfolio?.unrealized_pct ?? 0;
  const realizedYtdNis = portfolio?.realized_ytd_nis ?? 0;
  const dividendsYtdNis = portfolio?.dividends_ytd_nis ?? 0;

  const totalValue    = toDisplayCurrency(totalValueNis, currency as Currency, fxRate);
  const netInvested   = toDisplayCurrency(netInvestedNis, currency as Currency, fxRate);
  const unrealizedAbs = toDisplayCurrency(unrealizedNis, currency as Currency, fxRate);
  const realizedYtd   = toDisplayCurrency(realizedYtdNis, currency as Currency, fxRate);
  const dividendsYtd  = toDisplayCurrency(dividendsYtdNis, currency as Currency, fxRate);

  // ── Allocation slices ─────────────────────────────────────────────────────
  const allocByType = (portfolio?.allocation_by_type ?? []).map(s => ({
    label: s.label.charAt(0).toUpperCase() + s.label.slice(1),
    value: toDisplayCurrency(s.value_nis, currency as Currency, fxRate),
    color: TYPE_COLORS[s.label] ?? "#94A3B8",
  }));

  const allocByCurrency = (portfolio?.allocation_by_currency ?? []).map(s => ({
    label: s.label === "NIS" ? "NIS (₪)" : "USD ($)",
    value: toDisplayCurrency(s.value_nis, currency as Currency, fxRate),
    color: CCY_COLORS[s.label] ?? "#94A3B8",
  }));

  // ── FX label for KpiHero ─────────────────────────────────────────────────
  const fxLabel = fx
    ? `${fx.source === "override" ? "manual" : "Frankfurter"} · 1 USD = ₪${fxRate.toFixed(3)}`
    : undefined;

  // ── Greeting ─────────────────────────────────────────────────────────────
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const greeting = `${timeGreeting}, ${user?.username ?? "there"}`;

  const isFirstRun = !portfolioLoading && (portfolio?.investment_count ?? 0) === 0;

  return (
    <AppShell
      theme={theme}
      onThemeToggle={toggleTheme}
      currency={currency as Currency}
      onCurrencyChange={setCurrency as (c: Currency) => void}
      userName={user?.username ?? "You"}
      onLogout={logout}
      greeting={greeting}
      onRefresh={refresh}
      isRefreshing={isRefreshing}
      lastSync={lastSync}
    >
      {/* Loading state */}
      {portfolioLoading && (
        <div className="cf-dashboard-skeleton">
          <SkeletonShimmer width="100%" height={280} />
          <div className="cf-row-2">
            <SkeletonShimmer width="100%" height={340} />
            <SkeletonShimmer width="100%" height={340} />
          </div>
          <SkeletonShimmer width="100%" height={260} />
        </div>
      )}

      {/* First-run welcome */}
      {isFirstRun && (
        <WelcomeState userName={user?.username} />
      )}

      {/* Populated dashboard */}
      {!portfolioLoading && !isFirstRun && (
        <>
          <KpiHero
            totalValue={totalValue}
            totalValueAlt={totalValueAlt}
            unrealizedPct={unrealizedPct}
            unrealizedAbs={unrealizedAbs}
            netInvested={netInvested}
            realizedYtd={realizedYtd}
            dividendsYtd={dividendsYtd}
            currency={currency as Currency}
            series={[{ m: "Now", v: totalValue }]}
            fxLabel={fxLabel}
          />

          <div className="cf-row-2">
            <ChartCard
              currency={currency as Currency}
              fxRate={fxRate}
              totalValue={totalValue}
            />
            <AllocationCard
              byType={allocByType}
              byCurrency={allocByCurrency}
              currency={currency as Currency}
            />
          </div>

          <ActivityList
            items={recentTxs}
            currency={currency as Currency}
            onViewAll={() => { window.location.href = "/transactions"; }}
          />
        </>
      )}
    </AppShell>
  );
}
