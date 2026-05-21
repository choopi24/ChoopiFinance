import { useState } from "react";
import { Moon, Sun, Info, AlertTriangle } from "lucide-react";
import { useTheme } from "../../hooks/useTheme";
import { useCurrency } from "../../hooks/useCurrency";
import {
  MOCK_KPIS, MOCK_SERIES, MOCK_ALLOC_TYPE, MOCK_ALLOC_CCY,
  MOCK_INVESTMENTS, MOCK_REALIZED_YEARS, MOCK_TRANSACTIONS,
} from "../../lib/mock";
import { fmt } from "../../lib/fmt";
import type { AssetType } from "@choopi/shared";

import { Button, IconButton } from "../../components/Button";
import { Pill } from "../../components/Pill";
import { Chip } from "../../components/Chip";
import { Segment } from "../../components/Segment";
import { Toggle } from "../../components/Toggle";
import { SkeletonShimmer, SkeletonCard } from "../../components/SkeletonShimmer";
import { Card, CardHead } from "../../components/Card";
import { AssetIcon } from "../../components/AssetIcon";
import { HostPill } from "../../components/HostPill";
import { EmptyState } from "../../components/EmptyState";
import { Field } from "../../components/Field";
import { PasswordMeter } from "../../components/PasswordMeter";
import { KpiStat } from "../../components/KpiStat";
import { KpiHero } from "../../components/KpiHero";
import { LineChart } from "../../components/LineChart";
import { AllocationCard } from "../../components/AllocationCard";
import { ActivityList } from "../../components/ActivityList";
import { DataTable, type Column } from "../../components/DataTable";
import { Modal } from "../../components/Modal";
import { TypeCard } from "../../components/TypeCard";
import { MergePrompt } from "../../components/MergePrompt";
import { YearBar } from "../../components/YearBar";
import { SettingRow } from "../../components/SettingRow";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{
        margin: 0,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "var(--text-faint)",
        borderBottom: "1px solid var(--border)",
        paddingBottom: 10,
      }}>
        {title}
      </h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        {children}
      </div>
    </section>
  );
}

const INV_COLUMNS: Column<(typeof MOCK_INVESTMENTS)[0]>[] = [
  {
    key: "name",
    header: "Asset",
    render: (row) => (
      <div className="cf-inv-name">
        <AssetIcon type={row.type} ticker={row.ticker} size={34} />
        <div>
          <div className="cf-inv-title">{row.name} <span className="cf-inv-ticker">{row.ticker}</span></div>
          <div className={["cf-inv-sub", (row as any).stale ? "is-stale" : ""].filter(Boolean).join(" ")}>{row.sub}</div>
        </div>
      </div>
    ),
    width: "220px",
  },
  {
    key: "value",
    header: "Value",
    align: "right",
    render: (row) => <span className="mono">{fmt(row.value, { currency: row.ccy })}</span>,
  },
  {
    key: "change24",
    header: "24h",
    align: "right",
    render: (row) => (
      row.change24 !== 0
        ? <span className={["mono", row.change24 > 0 ? "is-pos" : "is-neg"].join(" ")}>
            {row.change24 > 0 ? "+" : ""}{row.change24}%
          </span>
        : <span className="mono" style={{ color: "var(--text-faint)" }}>—</span>
    ),
  },
];

const ASSET_TYPES: AssetType[] = ["crypto", "stock", "etf", "pension", "education", "other"];

export default function ComponentsPage() {
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();
  const [pw, setPw] = useState("");
  const [toggle1, setToggle1] = useState(false);
  const [toggle2, setToggle2] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<AssetType | null>("crypto");
  const [expandedYear, setExpandedYear] = useState<number | null>(2026);
  const [activeChip, setActiveChip] = useState("All");

  const maxAbs = Math.max(...MOCK_REALIZED_YEARS.map((y) => Math.abs(y.total)));

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-sans)" }}>
      {/* Sticky topbar */}
      <div style={{
        position: "sticky", top: 0, zIndex: 50,
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
        padding: "12px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div className="cf-brand-mark" style={{ width: 28, height: 28, fontSize: 13, background: "linear-gradient(135deg,var(--grad-from),var(--grad-to))", color: "#fff", display: "grid", placeItems: "center", borderRadius: 8 }}>C</div>
          <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 18 }}>choopi</span>
          <span style={{ fontSize: 11, color: "var(--text-faint)", padding: "2px 8px", border: "1px solid var(--border)", borderRadius: 999 }}>Component Showcase</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Segment options={[{ value: "NIS", label: "₪ NIS" }, { value: "USD", label: "$ USD" }]} value={currency} onChange={setCurrency} size="sm" />
          <IconButton onClick={toggleTheme} title="Toggle theme">
            {theme === "light" ? <Moon size={16} strokeWidth={1.6} /> : <Sun size={16} strokeWidth={1.6} />}
          </IconButton>
        </div>
      </div>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px 64px", display: "flex", flexDirection: "column", gap: 40 }}>

        {/* Buttons */}
        <Section title="Buttons">
          <Button>Default</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="grad">Gradient</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button size="sm">Small</Button>
          <Button size="lg" variant="grad">Large grad</Button>
          <IconButton><Info size={16} strokeWidth={1.6} /></IconButton>
        </Section>

        {/* Pills & Chips */}
        <Section title="Pills & Chips">
          <Pill>Default</Pill>
          <Pill variant="pos">+18.05%</Pill>
          <Pill variant="neg">-3.20%</Pill>
          <Pill variant="neutral">Neutral</Pill>
          {["All", "Crypto", "Stocks", "ETFs", "Pension"].map((label) => (
            <Chip key={label} active={activeChip === label} onClick={() => setActiveChip(label)}>
              {label}
            </Chip>
          ))}
        </Section>

        {/* Segment */}
        <Section title="Segment">
          <Segment
            options={[{ value: "1m", label: "1M" }, { value: "3m", label: "3M" }, { value: "6m", label: "6M" }, { value: "1y", label: "1Y" }]}
            value="1y"
            onChange={() => {}}
            size="sm"
          />
          <Segment
            options={[{ value: "type", label: "By Type" }, { value: "ccy", label: "By Currency" }]}
            value="type"
            onChange={() => {}}
          />
          <Segment
            options={[{ value: "a", label: "Option A" }, { value: "b", label: "Option B" }, { value: "c", label: "Option C" }]}
            value="b"
            onChange={() => {}}
            size="lg"
          />
        </Section>

        {/* Toggle */}
        <Section title="Toggle">
          <Toggle checked={toggle1} onChange={setToggle1} label="Notifications" />
          <Toggle checked={toggle2} onChange={setToggle2} label="Auto-refresh" />
          <Toggle checked={false} onChange={() => {}} label="Disabled" disabled />
        </Section>

        {/* Skeleton */}
        <Section title="Skeleton Shimmer">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <SkeletonShimmer width={180} height={14} />
            <SkeletonShimmer width={280} height={36} />
            <SkeletonShimmer width={140} height={11} />
          </div>
          <div style={{ width: 260 }}>
            <SkeletonCard lines={4} />
          </div>
        </Section>

        {/* Asset Icons */}
        <Section title="Asset Icons">
          {ASSET_TYPES.map((type) => (
            <div key={type} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <AssetIcon type={type} size={40} />
              <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{type}</span>
            </div>
          ))}
        </Section>

        {/* Host Pill */}
        <Section title="Host Pill">
          <HostPill host="192.168.1.42:5173" />
          <HostPill host="choopi.local:5173" label="Running at" />
        </Section>

        {/* Empty State */}
        <Section title="Empty State">
          <div style={{ width: 360, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--surface)" }}>
            <EmptyState
              icon={<Info size={20} strokeWidth={1.6} />}
              title="No investments yet"
              description="Add your first investment to start tracking your portfolio."
              action={{ label: "Add investment", onClick: () => {} }}
            />
          </div>
        </Section>

        {/* Fields */}
        <Section title="Form Fields">
          <div style={{ display: "flex", flexDirection: "column", gap: 14, width: 300 }}>
            <Field label="Email" type="email" placeholder="you@example.com" />
            <Field label="Amount" prefix="₪" placeholder="0.00" />
            <Field label="Password" password placeholder="Min 8 characters" value={pw} onChange={(e) => setPw(e.target.value)} />
            <PasswordMeter value={pw} />
            <Field label="With error" error="This field is required" placeholder="..." />
            <Field label="With hint" hint="Looks good!" placeholder="..." />
          </div>
        </Section>

        {/* KPI Stats */}
        <Section title="KPI Stats">
          <Card>
            <div className="cf-kpi-hero-stats" style={{ display: "flex" }}>
              <KpiStat
                label="Unrealized P&L"
                value={fmt(MOCK_KPIS.unrealizedAbs, { currency })}
                change={MOCK_KPIS.unrealizedPct}
                changeLabel="all time"
              />
              <KpiStat
                label="Realized YTD"
                value={fmt(MOCK_KPIS.realizedYtd, { currency })}
                change={MOCK_KPIS.realizedYtdPct}
                changeLabel="vs invested"
              />
              <KpiStat
                label="Net Invested"
                value={fmt(MOCK_KPIS.netInvested, { currency })}
              />
            </div>
          </Card>
        </Section>

        {/* KPI Hero */}
        <Section title="KPI Hero">
          <div style={{ width: "100%" }}>
            <KpiHero
              totalValue={MOCK_KPIS.totalValue}
              totalValueAlt={MOCK_KPIS.totalValueUsd}
              unrealizedPct={MOCK_KPIS.unrealizedPct}
              unrealizedAbs={MOCK_KPIS.unrealizedAbs}
              netInvested={MOCK_KPIS.netInvested}
              realizedYtd={MOCK_KPIS.realizedYtd}
              dividendsYtd={1245}
              currency={currency}
              series={MOCK_SERIES}
            />
          </div>
        </Section>

        {/* Line Chart */}
        <Section title="Line Chart">
          <div style={{ width: "100%" }}>
            <Card>
              <CardHead title="Portfolio value over time" sub="Last 12 months" />
              <LineChart data={MOCK_SERIES} currency={currency} />
            </Card>
          </div>
        </Section>

        {/* Allocation Card */}
        <Section title="Allocation (Donut)">
          <div style={{ width: 380 }}>
            <AllocationCard byType={MOCK_ALLOC_TYPE} byCurrency={MOCK_ALLOC_CCY} currency={currency} />
          </div>
        </Section>

        {/* Activity List */}
        <Section title="Activity List">
          <div style={{ width: "100%" }}>
            <ActivityList items={[]} currency={currency} onViewAll={() => {}} isEmpty />
          </div>
        </Section>

        {/* Data Table */}
        <Section title="Data Table">
          <div style={{ width: "100%", background: "var(--surface)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
            <div className="cf-card-head">
              <div className="cf-card-title">Investments</div>
            </div>
            <DataTable
              columns={INV_COLUMNS}
              rows={MOCK_INVESTMENTS}
              rowKey={(r) => r.id}
            />
          </div>
        </Section>

        {/* Modal */}
        <Section title="Modal">
          <Button onClick={() => setModalOpen(true)}>Open Modal</Button>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title="Add Investment"
            footer={
              <>
                <Button onClick={() => setModalOpen(false)}>Cancel</Button>
                <Button variant="grad">Save</Button>
              </>
            }
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <MergePrompt
                message="We found an existing Bitcoin entry. Would you like to merge this with your existing position?"
                action={{ label: "Merge", onClick: () => {} }}
                onDismiss={() => {}}
                icon={<AlertTriangle size={16} strokeWidth={1.6} />}
              />
              <Field label="Asset name" placeholder="e.g. Bitcoin" />
              <Field label="Quantity" prefix="#" placeholder="0.0000" />
            </div>
          </Modal>
        </Section>

        {/* Type Cards */}
        <Section title="Type Cards">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, width: "100%", maxWidth: 600 }}>
            {(["crypto", "stock", "etf", "pension", "education", "other"] as AssetType[]).map((type) => (
              <TypeCard
                key={type}
                type={type}
                label={type.charAt(0).toUpperCase() + type.slice(1)}
                description="Tap to select"
                selected={selectedType === type}
                onClick={() => setSelectedType(type)}
              />
            ))}
          </div>
        </Section>

        {/* Year Bars */}
        <Section title="Year Bars (Realized P&L)">
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
            {MOCK_REALIZED_YEARS.map((yr) => (
              <YearBar
                key={yr.year}
                data={yr}
                maxAbs={maxAbs}
                currency={currency}
                expanded={expandedYear === yr.year}
                onClick={() => setExpandedYear(expandedYear === yr.year ? null : yr.year)}
              />
            ))}
          </div>
        </Section>

        {/* Setting Rows */}
        <Section title="Setting Rows">
          <div style={{ width: "100%", background: "var(--surface)", borderRadius: 12, border: "1px solid var(--border)", padding: "0 24px" }}>
            <SettingRow label="Currency" description="Default display currency for portfolio values.">
              <Segment options={[{ value: "NIS", label: "₪ NIS" }, { value: "USD", label: "$ USD" }]} value={currency} onChange={setCurrency} size="sm" />
            </SettingRow>
            <SettingRow label="Auto-refresh prices" description="Fetch live prices every 60 seconds.">
              <Toggle checked={toggle2} onChange={setToggle2} />
            </SettingRow>
            <SettingRow label="Delete all data" description="Permanently delete your account and all data." danger>
              <Button variant="danger" size="sm">Delete</Button>
            </SettingRow>
          </div>
        </Section>

        {/* Transactions table */}
        <Section title="Transactions Table">
          <div style={{ width: "100%", background: "var(--surface)", borderRadius: 12, border: "1px solid var(--border)", overflow: "hidden" }}>
            <div className="cf-card-head">
              <div className="cf-card-title">Recent Transactions</div>
            </div>
            <DataTable
              columns={[
                { key: "date", header: "Date", render: (r) => <span className="mono">{r.date}</span> },
                { key: "kind", header: "Type", render: (r) => <span className="cf-act-kind">{r.kind}</span> },
                { key: "asset", header: "Asset", render: (r) => <span style={{ fontWeight: 500 }}>{r.asset}</span> },
                { key: "qty", header: "Qty", align: "right", render: (r) => <span className="mono">{r.qty}</span> },
                { key: "total", header: "Total", align: "right", render: (r) => <span className="mono">{r.total}</span> },
                { key: "fee", header: "Fee", align: "right", render: (r) => <span className="mono" style={{ color: "var(--text-faint)" }}>{r.fee}</span> },
                { key: "note", header: "Note", render: (r) => <span style={{ color: "var(--text-soft)", fontSize: 12 }}>{r.note}</span> },
              ]}
              rows={MOCK_TRANSACTIONS}
              rowKey={(r) => r.id}
            />
          </div>
        </Section>

      </div>
    </div>
  );
}
