import type { Currency } from "@choopi/shared";
import { fmt } from "../lib/fmt";
import { Card } from "./Card";
import { Button } from "./Button";
import type { Transaction } from "../hooks/useTransactions";

const KIND_COLORS: Record<string, string> = {
  BUY:    "var(--emerald)",
  SELL:   "var(--rose)",
  DIV:    "var(--c-stocks)",
  UPDATE: "var(--text-faint)",
};

const KIND_BG: Record<string, string> = {
  BUY:    "var(--emerald-soft)",
  SELL:   "var(--rose-soft)",
  DIV:    "rgba(14,165,233,0.10)",
  UPDATE: "var(--surface-2)",
};

function relativeDate(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1_000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface ActivityRowProps {
  tx: Transaction;
}

function ActivityRow({ tx }: ActivityRowProps) {
  const color = KIND_COLORS[tx.kind] ?? "var(--text-faint)";
  const bg = KIND_BG[tx.kind] ?? "var(--surface-2)";

  const sub = tx.kind === "BUY" || tx.kind === "SELL"
    ? tx.units != null
      ? `${tx.units.toLocaleString("en-US", { maximumFractionDigits: 6 })} units @ ${fmt(tx.price_per_unit ?? 0, { currency: tx.currency })}`
      : tx.investment_type
    : tx.notes ?? tx.investment_type;

  return (
    <li>
      <div
        className="cf-act-icon"
        style={{ color, backgroundColor: bg, borderColor: "transparent" }}
      >
        <span className="cf-act-kind">{tx.kind}</span>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="cf-act-asset">{tx.investment_name}</div>
        <div className="cf-act-sub">{sub}</div>
        {tx.kind === "SELL" && tx.realized_pl != null && (
          <div
            className="cf-act-sub mono"
            style={{ color: tx.realized_pl >= 0 ? "var(--emerald)" : "var(--rose)", marginTop: 1 }}
          >
            P/L: {tx.realized_pl >= 0 ? "+" : ""}{fmt(tx.realized_pl, { currency: tx.currency })}
          </div>
        )}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div className="cf-act-val mono">{fmt(tx.total_amount, { currency: tx.currency })}</div>
        <div className="cf-act-when">{relativeDate(tx.occurred_at)}</div>
      </div>
    </li>
  );
}

interface ActivityListProps {
  items: Transaction[];
  currency?: Currency;
  onViewAll?: () => void;
  isEmpty?: boolean;
}

export function ActivityList({ items, onViewAll, isEmpty }: ActivityListProps) {
  return (
    <Card pad={false}>
      <div className="cf-card-head">
        <div>
          <div className="cf-card-title">Recent Activity</div>
        </div>
        {onViewAll && (
          <Button variant="ghost" size="sm" onClick={onViewAll}>View all</Button>
        )}
      </div>
      <ul className="cf-activity-list">
        {isEmpty || items.length === 0 ? (
          <li style={{ padding: "32px 20px", textAlign: "center", color: "var(--text-faint)", fontSize: 13 }}>
            No transactions yet
          </li>
        ) : (
          items.map((tx) => (
            <ActivityRow key={tx.id} tx={tx} />
          ))
        )}
      </ul>
    </Card>
  );
}
