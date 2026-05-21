/**
 * BackfillModal — lets users add multiple historical transactions to an existing
 * investment in a single operation.
 *
 * Market types (crypto/stock/etf): rows support BUY, SELL, DIV.
 *   BUY/SELL: units + price (total auto-computed) or direct total.
 *   DIV: total amount only.
 *
 * Manual types (pension/education/other): rows support UPDATE, DEPOSIT.
 *   Both: total amount only.
 *
 * On save: POST /api/transactions/bulk → recomputeRealized (server-side) →
 *          cache invalidated by useBulkTransactions.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Trash2 } from "lucide-react";
import { Button } from "./Button";
import { useBulkTransactions } from "../hooks/useInvestments";
import type { Investment, BulkTransactionRow } from "../hooks/useInvestments";
import type { Currency } from "@choopi/shared";

// ── Types ─────────────────────────────────────────────────────────────────────

type MarketKind = "BUY" | "SELL" | "DIV";
type ManualKind = "UPDATE" | "DEPOSIT";

interface RowState {
  _id: string;
  kind: MarketKind | ManualKind;
  date: string;
  units: string;
  price: string;
  total: string;
  currency: Currency;
  notes: string;
}

const MARKET_KINDS: { value: MarketKind; label: string }[] = [
  { value: "BUY",  label: "Buy" },
  { value: "SELL", label: "Sell" },
  { value: "DIV",  label: "Dividend" },
];
const MANUAL_KINDS: { value: ManualKind; label: string }[] = [
  { value: "UPDATE",  label: "Balance snapshot" },
  { value: "DEPOSIT", label: "Deposit" },
];

const MARKET_TYPES = new Set(["crypto", "stock", "etf"]);

function today() { return new Date().toISOString().slice(0, 10); }

function makeRow(defaultKind: MarketKind | ManualKind): RowState {
  return {
    _id: crypto.randomUUID(),
    kind: defaultKind,
    date: today(),
    units: "",
    price: "",
    total: "",
    currency: "USD",
    notes: "",
  };
}

// ── Sub-component: single backfill row ────────────────────────────────────────

interface RowEditorProps {
  row: RowState;
  isMarket: boolean;
  onChange: (id: string, field: keyof RowState, value: string) => void;
  onRemove: (id: string) => void;
}

function RowEditor({ row, isMarket, onChange, onRemove }: RowEditorProps) {
  const kinds = isMarket ? MARKET_KINDS : MANUAL_KINDS;
  const needsUnitsPrice = isMarket && (row.kind === "BUY" || row.kind === "SELL");

  // Auto-compute total when units or price change
  function handleUnitsOrPrice(field: "units" | "price", val: string) {
    onChange(row._id, field, val);
    const u = field === "units" ? Number(val) : Number(row.units);
    const p = field === "price" ? Number(val)  : Number(row.price);
    if (!isNaN(u) && !isNaN(p) && u > 0 && p >= 0) {
      onChange(row._id, "total", String(u * p));
    }
  }

  return (
    <div style={{
      border: "1px solid var(--border)",
      borderRadius: 8,
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 10,
      background: "var(--surface-raised)",
    }}>
      {/* Row 1: kind · date · currency · remove */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 0.7fr auto", gap: 8, alignItems: "end" }}>
        <div className="cf-field" style={{ margin: 0 }}>
          <label>Type</label>
          <select
            className="cf-select"
            value={row.kind}
            onChange={e => onChange(row._id, "kind", e.target.value)}
          >
            {kinds.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div className="cf-field" style={{ margin: 0 }}>
          <label>Date</label>
          <input
            type="date"
            value={row.date}
            max={today()}
            onChange={e => onChange(row._id, "date", e.target.value)}
          />
        </div>
        <div className="cf-field" style={{ margin: 0 }}>
          <label>Ccy</label>
          <select
            className="cf-select"
            value={row.currency}
            onChange={e => onChange(row._id, "currency", e.target.value)}
          >
            <option value="NIS">₪ NIS</option>
            <option value="USD">$ USD</option>
          </select>
        </div>
        <div style={{ paddingBottom: 2 }}>
          <button
            className="cf-iconbtn"
            style={{ color: "var(--rose)" }}
            onClick={() => onRemove(row._id)}
            title="Remove row"
          >
            <Trash2 size={14} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      {/* Row 2: amounts */}
      {needsUnitsPrice ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <div className="cf-field" style={{ margin: 0 }}>
            <label>Units</label>
            <input
              type="number" min="0" step="any"
              value={row.units}
              onChange={e => handleUnitsOrPrice("units", e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="cf-field" style={{ margin: 0 }}>
            <label>Price / unit</label>
            <input
              type="number" min="0" step="any"
              value={row.price}
              onChange={e => handleUnitsOrPrice("price", e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="cf-field" style={{ margin: 0 }}>
            <label>Total</label>
            <input
              type="number" min="0" step="any"
              value={row.total}
              onChange={e => onChange(row._id, "total", e.target.value)}
              placeholder="auto"
            />
          </div>
        </div>
      ) : (
        <div className="cf-field" style={{ margin: 0 }}>
          <label>Amount</label>
          <input
            type="number" min="0" step="any"
            value={row.total}
            onChange={e => onChange(row._id, "total", e.target.value)}
            placeholder="0"
          />
        </div>
      )}

      {/* Row 3: notes (optional) */}
      <div className="cf-field" style={{ margin: 0 }}>
        <label>Notes (optional)</label>
        <input
          value={row.notes}
          onChange={e => onChange(row._id, "notes", e.target.value)}
          placeholder=""
        />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface BackfillModalProps {
  investment: Investment;
  onClose: () => void;
}

export function BackfillModal({ investment, onClose }: BackfillModalProps) {
  const isMarket = MARKET_TYPES.has(investment.type);
  const defaultKind: MarketKind | ManualKind = isMarket ? "BUY" : "UPDATE";

  const [rows, setRows] = useState<RowState[]>([makeRow(defaultKind)]);
  const [error, setError] = useState<string | null>(null);

  const bulkTx = useBulkTransactions();

  function addRow() {
    setRows(prev => [...prev, makeRow(defaultKind)]);
  }

  function removeRow(id: string) {
    setRows(prev => prev.filter(r => r._id !== id));
  }

  function updateRow(id: string, field: keyof RowState, value: string) {
    setRows(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r));
  }

  async function handleSave() {
    setError(null);
    if (rows.length === 0) { setError("Add at least one row"); return; }

    const transactions: BulkTransactionRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.date) { setError(`Row ${i + 1}: date is required`); return; }
      if (new Date(row.date) > new Date()) { setError(`Row ${i + 1}: date cannot be in the future`); return; }

      const needsUnitsPrice = isMarket && (row.kind === "BUY" || row.kind === "SELL");
      const total = row.total ? Number(row.total) : null;
      const units = row.units ? Number(row.units) : null;
      const price = row.price ? Number(row.price) : null;

      // Resolve total from units×price if not directly provided
      const resolvedTotal = total ?? (units != null && price != null ? units * price : null);

      if (resolvedTotal == null || isNaN(resolvedTotal) || resolvedTotal < 0) {
        setError(`Row ${i + 1}: a valid amount is required`); return;
      }
      if (needsUnitsPrice && (!units || units <= 0)) {
        setError(`Row ${i + 1}: units must be a positive number for ${row.kind}`); return;
      }

      transactions.push({
        kind: row.kind as BulkTransactionRow["kind"],
        units: needsUnitsPrice && units ? units : undefined,
        price_per_unit: needsUnitsPrice && price ? price : undefined,
        total_amount: resolvedTotal,
        currency: row.currency,
        occurred_at: new Date(row.date).toISOString(),
        notes: row.notes.trim() || undefined,
      });
    }

    try {
      await bulkTx.mutateAsync({ investment_id: investment.id, transactions });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return createPortal(
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div
        className="cf-modal"
        style={{ maxWidth: 600 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="cf-modal-head">
          <div>
            <div className="cf-modal-step">Backfill history</div>
            <div className="cf-modal-title">{investment.name}</div>
          </div>
          <button className="cf-icon-btn" onClick={onClose} title="Close">
            <X size={16} strokeWidth={1.6} />
          </button>
        </div>

        {error && <div className="cf-modal-error">{error}</div>}

        <div className="cf-modal-body">
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 14 }}>
            Add past {isMarket ? "transactions" : "balance snapshots and deposits"} in
            chronological order. FIFO realized P/L will recompute after saving.
          </div>

          {/* Rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map(row => (
              <RowEditor
                key={row._id}
                row={row}
                isMarket={isMarket}
                onChange={updateRow}
                onRemove={removeRow}
              />
            ))}
          </div>

          {/* Add row */}
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={13} strokeWidth={2} />}
            onClick={addRow}
            style={{ marginTop: 10 }}
          >
            Add row
          </Button>

          {/* Footer */}
          <div className="cf-modal-actions" style={{ marginTop: 20 }}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={bulkTx.isPending || rows.length === 0}
            >
              {bulkTx.isPending
                ? "Saving…"
                : `Save ${rows.length} transaction${rows.length !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
