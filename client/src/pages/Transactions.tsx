import { useState, useMemo } from "react";
import { EmptyState } from "../components/EmptyState";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../hooks/useTheme";
import { useCurrency } from "../hooks/useCurrency";
import { AppShell } from "../components/AppShell";
import { TransactionDrawer } from "../components/TransactionDrawer";
import {
  useTransactions, useDeleteTransaction, useFifoAffected,
  type Transaction, type TransactionFilters,
} from "../hooks/useTransactions";
import type { TransactionKind, Currency } from "@choopi/shared";
import { Download, Trash2, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { api } from "../lib/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

const KIND_CHIPS: { id: TransactionKind | "ALL"; label: string }[] = [
  { id: "ALL",    label: "All" },
  { id: "BUY",   label: "Buy" },
  { id: "SELL",  label: "Sell" },
  { id: "DIV",   label: "Dividend" },
  { id: "UPDATE", label: "Update" },
];

function fmt(n: number | null | undefined, cur = "NIS") {
  if (n == null) return "—";
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: cur === "NIS" ? "ILS" : cur,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ── Delete confirmation mini-modal ────────────────────────────────────────────

function DeleteModal({
  tx,
  onConfirm,
  onCancel,
}: {
  tx: Transaction;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { data: affected } = useFifoAffected(tx.id);
  const deleteTx = useDeleteTransaction();

  async function doDelete() {
    await deleteTx.mutateAsync(tx.id);
    onConfirm();
  }

  return (
    <div className="cf-modal-backdrop">
      <div className="cf-delete-modal" style={{ maxWidth: 400 }}>
        <div className="cf-delete-icon">🗑</div>
        <h3 style={{ margin: "12px 0 6px", fontSize: 16 }}>Delete transaction?</h3>
        <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "0 0 12px" }}>
          {tx.kind} — {tx.investment_name} — {fmtDate(tx.occurred_at)}
        </p>
        {affected && affected.affected_sells > 0 && (
          <div className="cf-delete-consequences">
            Deleting this transaction will recalculate the P/L for{" "}
            <strong>{affected.affected_sells}</strong> subsequent sell(s).
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button className="cf-btn cf-btn-ghost" onClick={onCancel}>Cancel</button>
          <button
            className="cf-btn cf-btn-danger"
            onClick={doDelete}
            disabled={deleteTx.isPending}
          >
            {deleteTx.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Kind chip ─────────────────────────────────────────────────────────────────

function KindChip({ kind }: { kind: string }) {
  return <span className={`cf-kind-chip cf-kind-${kind.toLowerCase()}`}>{kind}</span>;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TransactionsPage() {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [currency, setCurrency] = useCurrency();

  const [kindFilter, setKindFilter] = useState<TransactionKind | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo]     = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [drawerTx, setDrawerTx] = useState<Transaction | null>(null);
  const [deletingTx, setDeletingTx] = useState<Transaction | null>(null);

  const filters: TransactionFilters = useMemo(() => ({
    kinds: kindFilter === "ALL" ? undefined : [kindFilter],
    from: from || undefined,
    to:   to   || undefined,
    page,
    per_page: 50,
  }), [kindFilter, from, to, page]);

  const { data, isLoading } = useTransactions(filters);
  const rows = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 50));

  // client-side search filter by investment name / ticker
  const displayed = search.trim()
    ? rows.filter((r: Transaction) =>
        r.investment_name.toLowerCase().includes(search.toLowerCase()) ||
        (r.ticker ?? "").toLowerCase().includes(search.toLowerCase()))
    : rows;

  function exportCsv() {
    const params = new URLSearchParams({ per_page: "10000" });
    if (kindFilter !== "ALL") params.set("kind", kindFilter);
    if (from) params.set("from", from);
    if (to)   params.set("to", to);

    api.get<{ success: true; data: { data: Transaction[] } }>(`/transactions?${params}`).then(res => {
      const txs: Transaction[] = res.data.data;
      const BOM = "﻿";
      const header = "Date,Asset,Kind,Units,Price,Total,Currency,Realized P/L,Notes";
      const lines = txs.map((t: Transaction) => [
        t.occurred_at.slice(0, 10),
        `"${t.investment_name}"`,
        t.kind,
        t.units ?? "",
        t.price_per_unit ?? "",
        t.total_amount,
        t.currency,
        t.realized_pl ?? "",
        `"${(t.notes ?? "").replace(/"/g, '""')}"`,
      ].join(","));
      const csv = BOM + [header, ...lines].join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "transactions.csv";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

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
          <h1 className="cf-page-title">Transaction History</h1>
          <p className="cf-page-sub">{total.toLocaleString()} transactions total</p>
        </div>
        <button className="cf-btn cf-btn-secondary" onClick={exportCsv}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      {/* Filter bar */}
      <div className="cf-filters-row">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {KIND_CHIPS.map(c => (
            <button
              key={c.id}
              className={["cf-chip", kindFilter === c.id ? "is-active" : ""].filter(Boolean).join(" ")}
              onClick={() => { setKindFilter(c.id as TransactionKind | "ALL"); setPage(1); }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            placeholder="Search asset…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="cf-input"
            style={{ width: 160 }}
          />
          <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} className="cf-input" style={{ width: 150 }} />
          <span style={{ color: "var(--text-faint)", fontSize: 12 }}>to</span>
          <input type="date" value={to}   onChange={e => { setTo(e.target.value);   setPage(1); }} className="cf-input" style={{ width: 150 }} />
        </div>
      </div>

      {/* Table */}
      <div className="cf-card" style={{ padding: 0, overflow: "hidden" }}>
        {isLoading ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-faint)" }}>Loading…</div>
        ) : displayed.length === 0 ? (
          <EmptyState
            icon="🔍"
            title="No transactions found"
            description="Try adjusting your filters or date range."
          />
        ) : (
          <div className="cf-tx-table-wrap">
            <table className="cf-tx-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Kind</th>
                  <th scope="col" style={{ textAlign: "right" }}>Units</th>
                  <th scope="col" style={{ textAlign: "right" }}>Price</th>
                  <th scope="col" style={{ textAlign: "right" }}>Total</th>
                  <th scope="col" style={{ textAlign: "right" }}>P/L</th>
                  <th scope="col">Notes</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((tx: Transaction) => {
                  const pl = tx.realized_pl;
                  const plColor = pl == null ? "var(--text-faint)" : pl >= 0 ? "var(--emerald)" : "var(--rose)";
                  return (
                    <tr key={tx.id} className="cf-tx-row" onClick={() => setDrawerTx(tx)}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtDate(tx.occurred_at)}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{tx.investment_name}</div>
                        {tx.ticker && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{tx.ticker}</div>}
                      </td>
                      <td><KindChip kind={tx.kind} /></td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {tx.units != null ? tx.units.toLocaleString("he-IL", { maximumFractionDigits: 8 }) : "—"}
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {fmt(tx.price_per_unit, tx.currency)}
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {fmt(tx.total_amount, tx.currency)}
                      </td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: plColor }}>
                        {pl != null ? fmt(pl, tx.currency) : "—"}
                      </td>
                      <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-faint)", fontSize: 12 }}>
                        {tx.notes ?? ""}
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button
                            className="cf-icon-btn"
                            title="Details"
                            onClick={() => setDrawerTx(tx)}
                          >
                            <ExternalLink size={13} />
                          </button>
                          <button
                            className="cf-icon-btn cf-icon-btn-danger"
                            title="Delete"
                            onClick={() => setDeletingTx(tx)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12, marginTop: 16 }}>
          <button
            className="cf-btn cf-btn-ghost"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            <ChevronRight size={14} />
          </button>
          <span style={{ fontSize: 13, color: "var(--text-faint)" }}>
            Page {page} of {totalPages}
          </span>
          <button
            className="cf-btn cf-btn-ghost"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            <ChevronLeft size={14} />
          </button>
        </div>
      )}

      <TransactionDrawer tx={drawerTx} onClose={() => setDrawerTx(null)} />

      {deletingTx && (
        <DeleteModal
          tx={deletingTx}
          onConfirm={() => setDeletingTx(null)}
          onCancel={() => setDeletingTx(null)}
        />
      )}
    </AppShell>
  );
}
