import { createPortal } from "react-dom";
import { X, TrendingUp, TrendingDown, RefreshCw } from "lucide-react";
import type { Transaction } from "../hooks/useTransactions";

interface Props {
  tx: Transaction | null;
  onClose: () => void;
}

const KIND_LABELS: Record<string, string> = {
  BUY: "Buy", SELL: "Sell", DIV: "Dividend", UPDATE: "Balance Update",
};

function fmt(n: number | null | undefined, currency = "NIS") {
  if (n == null) return "—";
  return new Intl.NumberFormat("he-IL", {
    style: "currency",
    currency: currency === "NIS" ? "ILS" : currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("he-IL", {
    year: "numeric", month: "long", day: "numeric",
  });
}

function KindIcon({ kind }: { kind: string }) {
  if (kind === "BUY")    return <TrendingUp size={16} style={{ color: "var(--emerald)" }} />;
  if (kind === "SELL")   return <TrendingDown size={16} style={{ color: "var(--rose)" }} />;
  if (kind === "DIV")    return <span style={{ fontSize: 14 }}>💰</span>;
  return <RefreshCw size={16} style={{ color: "var(--text-faint)" }} />;
}

function Row({ label, value, accent }: { label: string; value: React.ReactNode; accent?: "pos" | "neg" }) {
  const color = accent === "pos" ? "var(--emerald)" : accent === "neg" ? "var(--rose)" : "var(--text)";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ fontSize: 12, color: "var(--text-faint)", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 500, color, textAlign: "right" }}>{value}</span>
    </div>
  );
}

export function TransactionDrawer({ tx, onClose }: Props) {
  if (!tx) return null;

  const pl = tx.realized_pl;
  const plAccent = pl == null ? undefined : pl >= 0 ? "pos" : "neg";

  return createPortal(
    <>
      <div className="cf-drawer-overlay" onClick={onClose} />
      <div className="cf-drawer" role="dialog" aria-label="Transaction Details">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <KindIcon kind={tx.kind} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{tx.investment_name}</div>
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>{KIND_LABELS[tx.kind] ?? tx.kind}</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        <div>
          <Row label="Date"          value={fmtDate(tx.occurred_at)} />
          <Row label="Asset"         value={tx.investment_name} />
          {tx.ticker && <Row label="Ticker" value={tx.ticker} />}
          <Row label="Kind"          value={<span className={`cf-kind-chip cf-kind-${tx.kind.toLowerCase()}`}>{tx.kind}</span>} />
          {tx.units != null && <Row label="Units" value={tx.units.toLocaleString("en-US", { maximumFractionDigits: 8 })} />}
          {tx.price_per_unit != null && <Row label="Price / unit" value={fmt(tx.price_per_unit, tx.currency)} />}
          <Row label="Total"         value={fmt(tx.total_amount, tx.currency)} />
          <Row label="Currency"      value={tx.currency} />
          {pl != null && (
            <Row
              label="Realized P/L (FIFO)"
              value={fmt(pl, tx.currency)}
              accent={plAccent}
            />
          )}
          {tx.notes && <Row label="Notes" value={tx.notes} />}
        </div>

        {tx.kind === "SELL" && (
          <div style={{ marginTop: 20, padding: "12px 14px", background: "var(--surface-2)", borderRadius: 8 }}>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>Cost basis method</div>
            <div style={{ fontSize: 12, fontWeight: 500 }}>FIFO (First In, First Out)</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
              P/L is calculated against the oldest purchase lots in the portfolio.
            </div>
          </div>
        )}
      </div>
    </>,
    document.body
  );
}
