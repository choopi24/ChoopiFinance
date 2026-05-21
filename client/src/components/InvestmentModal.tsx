import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, ArrowLeft, GitMerge, Plus, Trash2 } from "lucide-react";
import { TypeCard } from "./TypeCard";
import { Button } from "./Button";
import { Segment } from "./Segment";
import {
  useCreateInvestment, useAddTransaction, useEditInvestment,
  useCheckExisting, useBulkTransactions,
} from "../hooks/useInvestments";
import { api } from "../lib/api";
import { fmt } from "../lib/fmt";
import type { AssetType, Currency } from "@choopi/shared";
import type { Investment, BulkTransactionRow } from "../hooks/useInvestments";

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPES: { type: AssetType; label: string; desc: string }[] = [
  { type: "crypto",    label: "Crypto",    desc: "Bitcoin, Ethereum, altcoins" },
  { type: "stock",     label: "Stock",     desc: "Equities on any exchange" },
  { type: "etf",       label: "ETF",       desc: "Index funds, UCITS ETFs" },
  { type: "pension",   label: "Pension",   desc: "Retirement savings fund" },
  { type: "education", label: "Education", desc: "Savings plan with liquidation date" },
  { type: "other",     label: "Other",     desc: "Real estate, collectibles, etc." },
];

const CCY_OPTIONS = [
  { value: "NIS" as Currency, label: "₪ NIS" },
  { value: "USD" as Currency, label: "$ USD" },
];
const KIND_OPTIONS = [
  { value: "BUY"  as const, label: "Buy" },
  { value: "SELL" as const, label: "Sell" },
];
const ENTRY_MODE_OPTIONS = [
  { value: "holding"     as const, label: "I already own this" },
  { value: "transaction" as const, label: "Log a transaction" },
];

const CRYPTO_SUGGESTIONS = ["BTC", "ETH", "SOL", "ADA", "XRP", "DOT"];
const MANUAL_TYPES = new Set(["pension", "education", "other"]);

interface IsinResult {
  isin: string; symbol: string; name: string;
  currency: string; etf_kind: string | null; asset_type: string; exchange: string | null;
}

// ── Main component ─────────────────────────────────────────────────────────────

interface InvestmentModalProps {
  mode: "add" | "edit";
  investment?: Investment | null;
  onClose: () => void;
}

export function InvestmentModal({ mode, investment, onClose }: InvestmentModalProps) {
  const [step, setStep]       = useState<1 | 2>(mode === "edit" ? 2 : 1);
  const [selType, setSelType] = useState<AssetType | null>(investment?.type ?? null);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  function pickType(t: AssetType) { setSelType(t); setStep(2); }

  return createPortal(
    <div className="cf-modal-backdrop" onClick={onClose}>
      <div
        className="cf-modal"
        style={{ maxWidth: step === 1 ? 560 : 540 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="cf-modal-head">
          <div>
            <div className="cf-modal-step">
              {mode === "edit" ? "Edit investment" : `Step ${step} of 2`}
            </div>
            <div className="cf-modal-title">
              {mode === "edit"
                ? investment?.name
                : step === 1 ? "What are you adding?" : `Add ${selType}`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {mode === "add" && step === 2 && (
              <button className="cf-icon-btn" onClick={() => setStep(1)} title="Back">
                <ArrowLeft size={16} strokeWidth={1.6} />
              </button>
            )}
            <button className="cf-icon-btn" onClick={onClose} title="Close">
              <X size={16} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        {error && <div className="cf-modal-error">{error}</div>}

        <div className="cf-modal-body">
          {step === 1 ? (
            <div className="cf-type-grid">
              {TYPES.map(({ type, label, desc }) => (
                <TypeCard key={type} type={type} label={label} description={desc}
                  selected={selType === type} onClick={() => pickType(type)} />
              ))}
            </div>
          ) : selType ? (
            <Step2
              type={selType}
              mode={mode}
              investment={investment ?? null}
              onClose={onClose}
              setError={setError}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Step 2 dispatcher ─────────────────────────────────────────────────────────

interface Step2Props {
  type: AssetType;
  mode: "add" | "edit";
  investment: Investment | null;
  onClose: () => void;
  setError: (e: string | null) => void;
}

function Step2({ type, mode, investment, onClose, setError }: Step2Props) {
  const [entryMode, setEntryMode] = useState<"holding" | "transaction">("holding");

  if (mode === "edit") {
    return <EditMetaForm investment={investment!} onClose={onClose} setError={setError} />;
  }

  const isManual = MANUAL_TYPES.has(type);

  return (
    <>
      {/* Entry mode toggle */}
      <div style={{ marginBottom: 16 }}>
        <Segment options={ENTRY_MODE_OPTIONS} value={entryMode} onChange={setEntryMode} />
      </div>

      {isManual ? (
        <ManualForm type={type} onClose={onClose} setError={setError} entryMode={entryMode} />
      ) : entryMode === "holding" ? (
        <HoldingMarketForm type={type} onClose={onClose} setError={setError} />
      ) : type === "crypto" ? (
        <CryptoForm onClose={onClose} setError={setError} />
      ) : (
        <StockForm onClose={onClose} setError={setError} isEtf={type === "etf"} />
      )}
    </>
  );
}

// ── Shared field helpers ──────────────────────────────────────────────────────

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="cf-field">
      <label>{label}</label>
      {children}
      {hint && <div className="cf-field-hint" style={{ color: "var(--text-faint)", fontSize: 11 }}>{hint}</div>}
    </div>
  );
}

function today() { return new Date().toISOString().slice(0, 10); }

// ── Merge prompt ──────────────────────────────────────────────────────────────

interface MergeInfo {
  id: number; name: string; ticker: string;
  remaining_units: number; current_value_nis: number; unrealized_pl_nis: number;
}

function MergeBanner({ info, onSeparate }: { info: MergeInfo; onSeparate: () => void }) {
  const isPos = info.unrealized_pl_nis >= 0;
  return (
    <div className="cf-merge-prompt" style={{ marginBottom: 0 }}>
      <div className="cf-merge-icon"><GitMerge size={16} strokeWidth={1.6} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>
          You already hold <strong>{info.ticker}</strong> in "{info.name}"
        </div>
        <div style={{ fontSize: 12, color: "var(--text-soft)", marginTop: 2 }}>
          {info.remaining_units.toLocaleString("en-US", { maximumFractionDigits: 6 })} units ·{" "}
          <span className={isPos ? "is-pos" : "is-neg"}>
            {isPos ? "+" : "−"}{fmt(Math.abs(info.unrealized_pl_nis), { currency: "NIS" })} P/L
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 4 }}>
          This will be merged into the existing position.
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onSeparate}>Create separate</Button>
    </div>
  );
}

// ── Holding form for market types (crypto / stock / etf) ──────────────────────
// Creates the investment + a synthetic BUY in one server call.

interface HoldingMarketFormProps {
  type: AssetType;
  onClose: () => void;
  setError: (e: string | null) => void;
}

function HoldingMarketForm({ type, onClose, setError }: HoldingMarketFormProps) {
  const isCrypto = type === "crypto";
  const isEtf    = type === "etf";

  const [ticker, setTicker]     = useState("");
  const [name, setName]         = useState("");
  const [isin, setIsin]         = useState("");
  const [isinLoading, setIsinLoading] = useState(false);
  const [units, setUnits]       = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [date, setDate]         = useState(today());
  const [broker, setBroker]     = useState("");
  const [notes, setNotes]       = useState("");
  const [forceSep, setForceSep] = useState(false);

  const upperTicker = ticker.toUpperCase().trim();
  const checkEnabled = upperTicker.length >= 1 && !forceSep;
  const { data: existing } = useCheckExisting(upperTicker, type, checkEnabled);

  const createInv = useCreateInvestment();
  const addTx     = useAddTransaction();
  const isPending = createInv.isPending || addTx.isPending;

  async function lookupIsin() {
    if (!isin || isin.length < 12) return;
    setIsinLoading(true);
    try {
      const res = await api.get<{ success: true; data: IsinResult }>(`/lookup/isin/${isin.toUpperCase()}`);
      const d = res.data;
      setTicker(d.symbol);
      if (!name) setName(d.name);
      if (d.currency === "USD" || d.currency === "NIS") setCurrency(d.currency as Currency);
    } catch {
      setError("ISIN not found — enter ticker manually");
    } finally {
      setIsinLoading(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    if (!upperTicker) { setError("Ticker is required"); return; }
    const u = Number(units);
    const p = Number(avgPrice || 0);
    if (!units || isNaN(u) || u <= 0) { setError("Units held must be a positive number"); return; }
    if (isNaN(p) || p < 0)            { setError("Average cost cannot be negative"); return; }
    if (!date || new Date(date) > new Date()) { setError("Date cannot be in the future"); return; }

    const asOf = new Date(date).toISOString();
    try {
      if (existing && !forceSep) {
        // Merge into existing investment: post a direct BUY transaction
        await addTx.mutateAsync({
          investment_id: existing.id,
          kind: "BUY",
          units: u,
          price_per_unit: p,
          total_amount: u * p,
          currency,
          occurred_at: asOf,
          notes: notes.trim() || "Initial holding (synthetic)",
        });
      } else {
        await createInv.mutateAsync({
          type,
          name: name.trim() || upperTicker,
          ticker: upperTicker,
          isin: isin.toUpperCase() || undefined,
          broker: broker.trim() || undefined,
          holding: { units: u, avg_price: p, currency, as_of: asOf },
        });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const total = Number(units || 0) * Number(avgPrice || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {isEtf && (
        <Field label="ISIN (optional — auto-fills ticker)">
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={isin}
              onChange={e => setIsin(e.target.value.toUpperCase())}
              placeholder="IE00B4L5Y983"
              style={{ flex: 1 }}
              onBlur={lookupIsin}
            />
            <Button variant="ghost" size="sm" onClick={lookupIsin} disabled={isinLoading}>
              {isinLoading ? "…" : "Lookup"}
            </Button>
          </div>
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label={isCrypto ? "Coin symbol" : "Ticker symbol"}>
          <input
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            placeholder={isCrypto ? "BTC" : isEtf ? "IWDA.AS" : "NVDA"}
            style={{ textTransform: "uppercase" }}
            autoFocus
          />
          {isCrypto && (
            <div className="cf-suggestions">
              {CRYPTO_SUGGESTIONS.map(s => (
                <button key={s} className="cf-suggestion-chip" onClick={() => setTicker(s)}>{s}</button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Name (optional)">
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder={isCrypto ? "Ledger, Binance…" : "Auto-filled from ISIN"} />
        </Field>
      </div>

      {existing && !forceSep && (
        <MergeBanner info={existing} onSeparate={() => setForceSep(true)} />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label={isCrypto ? "Units held" : "Shares held"} hint="Required">
          <input type="number" min="0" step="any" value={units}
            onChange={e => setUnits(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Avg cost per unit" hint="Leave 0 if unknown">
          <input type="number" min="0" step="any" value={avgPrice}
            onChange={e => setAvgPrice(e.target.value)} placeholder="0" />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Currency">
          <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
        </Field>
        <Field label="Acquired as of" hint="Date of acquisition">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            max={today()} />
        </Field>
      </div>

      {!isCrypto && (
        <Field label="Broker (optional)">
          <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="IBKR, Saxo…" />
        </Field>
      )}

      <Field label="Notes (optional)">
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
      </Field>

      <FormFooter
        total={total} currency={currency}
        onCancel={onClose} onSubmit={handleSubmit} isPending={isPending}
        submitLabel="Add holding"
      />
    </div>
  );
}

// ── Crypto form (Log a transaction mode) ──────────────────────────────────────

function CryptoForm({ onClose, setError }: { onClose: () => void; setError: (e: string | null) => void }) {
  const [ticker, setTicker]     = useState("");
  const [kind, setKind]         = useState<"BUY" | "SELL">("BUY");
  const [wallet, setWallet]     = useState("");
  const [units, setUnits]       = useState("");
  const [price, setPrice]       = useState("");
  const [currency, setCurrency] = useState<Currency>("NIS");
  const [date, setDate]         = useState(today());
  const [exchange, setExchange] = useState("");
  const [notes, setNotes]       = useState("");
  const [forceSep, setForceSep] = useState(false);

  const upperTicker = ticker.toUpperCase().trim();
  const checkEnabled = upperTicker.length >= 2 && kind === "BUY" && !forceSep;
  const { data: existing } = useCheckExisting(upperTicker, "crypto", checkEnabled);

  const createInv = useCreateInvestment();
  const addTx     = useAddTransaction();
  const isPending = createInv.isPending || addTx.isPending;

  async function handleSubmit() {
    setError(null);
    if (!upperTicker || !units || !price || !date) {
      setError("Ticker, units, price and date are required"); return;
    }
    try {
      let investmentId: number;
      if (existing && !forceSep) {
        investmentId = existing.id;
      } else {
        const inv = await createInv.mutateAsync({
          type: "crypto",
          name: wallet ? `${upperTicker} — ${wallet}` : upperTicker,
          ticker: upperTicker,
        });
        investmentId = inv.id;
      }
      await addTx.mutateAsync({
        investment_id: investmentId,
        kind,
        units: Number(units),
        price_per_unit: Number(price),
        total_amount: Number(units) * Number(price),
        currency,
        occurred_at: new Date(date).toISOString(),
        notes: [wallet && `Wallet: ${wallet}`, exchange && `Exchange: ${exchange}`, notes].filter(Boolean).join(" · ") || undefined,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const total = Number(units) * Number(price);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Coin symbol">
        <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
          placeholder="BTC" style={{ textTransform: "uppercase" }} />
        <div className="cf-suggestions">
          {CRYPTO_SUGGESTIONS.map(s => (
            <button key={s} className="cf-suggestion-chip" onClick={() => setTicker(s)}>{s}</button>
          ))}
        </div>
      </Field>

      {existing && !forceSep && (
        <MergeBanner info={existing} onSeparate={() => setForceSep(true)} />
      )}

      <Field label="Wallet name (optional)">
        <input value={wallet} onChange={e => setWallet(e.target.value)} placeholder="Ledger, Binance…" />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Transaction type">
          <Segment options={KIND_OPTIONS} value={kind} onChange={setKind} />
        </Field>
        <Field label="Currency">
          <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Units">
          <input type="number" min="0" step="any" value={units}
            onChange={e => setUnits(e.target.value)} placeholder="0.1" />
        </Field>
        <Field label="Price per unit">
          <input type="number" min="0" step="any" value={price}
            onChange={e => setPrice(e.target.value)} placeholder="0" />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Date">
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <Field label="Exchange (optional)">
          <input value={exchange} onChange={e => setExchange(e.target.value)} placeholder="Kraken…" />
        </Field>
      </div>

      <Field label="Notes (optional)">
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
      </Field>

      <FormFooter total={total} currency={currency} onCancel={onClose} onSubmit={handleSubmit} isPending={isPending} />
    </div>
  );
}

// ── Stock / ETF form (Log a transaction mode) ─────────────────────────────────

function StockForm({
  onClose, setError, isEtf,
}: { onClose: () => void; setError: (e: string | null) => void; isEtf: boolean }) {
  const [ticker, setTicker]     = useState("");
  const [isin, setIsin]         = useState("");
  const [isinLoading, setIsinLoading] = useState(false);
  const [etfKind, setEtfKind]   = useState<"accumulating" | "distributing" | "">("");
  const [kind, setKind]         = useState<"BUY" | "SELL">("BUY");
  const [name, setName]         = useState("");
  const [units, setUnits]       = useState("");
  const [price, setPrice]       = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [broker, setBroker]     = useState("");
  const [date, setDate]         = useState(today());
  const [notes, setNotes]       = useState("");
  const [forceSep, setForceSep] = useState(false);

  const upperTicker = ticker.toUpperCase().trim();
  const checkEnabled = upperTicker.length >= 1 && kind === "BUY" && !forceSep;
  const { data: existing } = useCheckExisting(upperTicker, isEtf ? "etf" : "stock", checkEnabled);

  const createInv = useCreateInvestment();
  const addTx     = useAddTransaction();
  const isPending = createInv.isPending || addTx.isPending;

  async function lookupIsin() {
    if (!isin || isin.length < 12) return;
    setIsinLoading(true);
    try {
      const res = await api.get<{ success: true; data: IsinResult }>(`/lookup/isin/${isin.toUpperCase()}`);
      const d = res.data;
      setTicker(d.symbol);
      if (!name) setName(d.name);
      if (d.currency === "USD" || d.currency === "NIS") setCurrency(d.currency as Currency);
      if (d.etf_kind === "accumulating" || d.etf_kind === "distributing") setEtfKind(d.etf_kind);
    } catch {
      setError("ISIN not found — enter ticker manually");
    } finally {
      setIsinLoading(false);
    }
  }

  async function handleSubmit() {
    setError(null);
    if (!upperTicker || !units || !price || !date) {
      setError("Ticker, units, price and date are required"); return;
    }
    try {
      let investmentId: number;
      if (existing && !forceSep) {
        investmentId = existing.id;
      } else {
        const inv = await createInv.mutateAsync({
          type: isEtf ? "etf" : "stock",
          name: name || upperTicker,
          ticker: upperTicker,
          isin: isin.toUpperCase() || undefined,
          broker: broker || undefined,
          etf_kind: isEtf ? (etfKind || undefined) : undefined,
        });
        investmentId = inv.id;
      }
      await addTx.mutateAsync({
        investment_id: investmentId,
        kind,
        units: Number(units),
        price_per_unit: Number(price),
        total_amount: Number(units) * Number(price),
        currency,
        occurred_at: new Date(date).toISOString(),
        notes: notes.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const total = Number(units) * Number(price);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {isEtf && (
        <Field label="ISIN (optional — auto-fills ticker & kind)">
          <div style={{ display: "flex", gap: 8 }}>
            <input value={isin} onChange={e => setIsin(e.target.value.toUpperCase())}
              placeholder="IE00B4L5Y983" style={{ flex: 1 }} onBlur={lookupIsin} />
            <Button variant="ghost" size="sm" onClick={lookupIsin} disabled={isinLoading}>
              {isinLoading ? "…" : "Lookup"}
            </Button>
          </div>
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Ticker symbol">
          <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            placeholder={isEtf ? "IWDA.AS" : "NVDA"} style={{ textTransform: "uppercase" }} />
        </Field>
        <Field label="Name (optional)">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Auto-filled from ISIN" />
        </Field>
      </div>

      {existing && !forceSep && (
        <MergeBanner info={existing} onSeparate={() => setForceSep(true)} />
      )}

      {isEtf && (
        <Field label="ETF kind">
          <select value={etfKind}
            onChange={e => setEtfKind(e.target.value as "accumulating" | "distributing" | "")}
            className="cf-select">
            <option value="">Unknown</option>
            <option value="accumulating">Accumulating (Acc)</option>
            <option value="distributing">Distributing (Dist)</option>
          </select>
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Transaction type">
          <Segment options={KIND_OPTIONS} value={kind} onChange={setKind} />
        </Field>
        <Field label="Currency">
          <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Shares">
          <input type="number" min="0" step="any" value={units}
            onChange={e => setUnits(e.target.value)} placeholder="10" />
        </Field>
        <Field label="Price per share">
          <input type="number" min="0" step="any" value={price}
            onChange={e => setPrice(e.target.value)} placeholder="0" />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Broker (optional)">
          <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="IBKR, Saxo…" />
        </Field>
        <Field label="Date">
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
      </div>

      <Field label="Notes (optional)">
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
      </Field>

      <FormFooter total={total} currency={currency} onCancel={onClose} onSubmit={handleSubmit} isPending={isPending} />
    </div>
  );
}

// ── Manual form (pension / education / other) ─────────────────────────────────
// entryMode = "holding": show full setup fields (balance, monthly_deposit for pension,
//                         DEPOSIT rows for edu/other)
// entryMode = "transaction": minimal — just create the account shell

interface DepositRow {
  _id: string;
  amount: string;
  currency: Currency;
  date: string;
}

function ManualForm({
  type, onClose, setError, entryMode,
}: { type: AssetType; onClose: () => void; setError: (e: string | null) => void; entryMode: "holding" | "transaction" }) {
  const [name, setName]                 = useState("");
  const [balance, setBalance]           = useState("");
  const [currency, setCurrency]         = useState<Currency>("NIS");
  const [liquidDate, setLiqDate]        = useState("");
  const [date, setDate]                 = useState(today());
  // Pension-specific
  const [monthlyDeposit, setMonthlyDep] = useState("");
  const [depCcy, setDepCcy]             = useState<Currency>("NIS");
  // Education / Other DEPOSIT rows (holding mode only)
  const [deposits, setDeposits]         = useState<DepositRow[]>([]);

  const createInv  = useCreateInvestment();
  const bulkTx     = useBulkTransactions();
  const isPending  = createInv.isPending || bulkTx.isPending;

  function addDepositRow() {
    setDeposits(prev => [...prev, { _id: crypto.randomUUID(), amount: "", currency: "NIS", date: today() }]);
  }
  function removeDepositRow(id: string) {
    setDeposits(prev => prev.filter(r => r._id !== id));
  }
  function updateDeposit(id: string, field: keyof DepositRow, value: string) {
    setDeposits(prev => prev.map(r => r._id === id ? { ...r, [field]: value } : r));
  }

  async function handleSubmit() {
    setError(null);
    const cleanName = name.trim();
    if (!cleanName) { setError("Name is required"); return; }

    const md = monthlyDeposit ? Number(monthlyDeposit) : undefined;
    if (md !== undefined && (isNaN(md) || md < 0)) { setError("Monthly deposit must be a non-negative number"); return; }

    try {
      const inv = await createInv.mutateAsync({
        type,
        name: cleanName,
        initial_balance: balance ? Number(balance) : undefined,
        currency,
        liquid_date: type === "education" && liquidDate ? liquidDate : undefined,
        occurred_at: new Date(date).toISOString(),
        monthly_deposit: type === "pension" && entryMode === "holding" ? md : undefined,
        deposit_currency: type === "pension" && entryMode === "holding" ? depCcy : undefined,
      });

      // For education/other in holding mode: add DEPOSIT rows via bulk endpoint
      if (entryMode === "holding" && (type === "education" || type === "other") && deposits.length > 0) {
        const validDeposits = deposits.filter(r => r.amount && Number(r.amount) > 0 && r.date);
        if (validDeposits.length > 0) {
          const rows: BulkTransactionRow[] = validDeposits.map(r => ({
            kind: "DEPOSIT" as const,
            total_amount: Number(r.amount),
            currency: r.currency,
            occurred_at: new Date(r.date).toISOString(),
          }));
          await bulkTx.mutateAsync({ investment_id: inv.id, transactions: rows });
        }
      }

      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Name">
        <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder={
          type === "pension" ? "Menora Pension" : type === "education" ? "Education Fund" : "Wine collection"
        } />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label={entryMode === "holding" ? "Current balance" : "Initial balance (optional)"}>
          <input type="number" min="0" step="any" value={balance}
            onChange={e => setBalance(e.target.value)} placeholder="0" />
        </Field>
        <Field label="Currency">
          <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
        </Field>
      </div>

      <Field label={entryMode === "holding" ? "Balance date" : "Date"}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          max={entryMode === "holding" ? today() : undefined} />
      </Field>

      {/* Pension: monthly deposit fields (holding mode only) */}
      {type === "pension" && entryMode === "holding" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Monthly deposit" hint="Used to calculate net invested">
            <input type="number" min="0" step="any" value={monthlyDeposit}
              onChange={e => setMonthlyDep(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Deposit currency">
            <Segment options={CCY_OPTIONS} value={depCcy} onChange={setDepCcy} />
          </Field>
        </div>
      )}

      {/* Education liquidation date */}
      {type === "education" && (
        <Field label="Liquidation date" hint="When the fund matures">
          <input type="date" value={liquidDate} onChange={e => setLiqDate(e.target.value)} />
        </Field>
      )}

      {/* Education / Other: initial DEPOSIT rows (holding mode only) */}
      {entryMode === "holding" && (type === "education" || type === "other") && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text-soft)" }}>
              Initial deposits (optional)
            </div>
            <Button variant="ghost" size="sm" icon={<Plus size={13} strokeWidth={2} />} onClick={addDepositRow}>
              Add deposit
            </Button>
          </div>
          {deposits.map(row => (
            <div key={row._id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 8, marginBottom: 8, alignItems: "end" }}>
              <Field label="Amount">
                <input type="number" min="0" step="any" value={row.amount}
                  onChange={e => updateDeposit(row._id, "amount", e.target.value)} placeholder="0" />
              </Field>
              <Field label="Ccy">
                <select className="cf-select" value={row.currency}
                  onChange={e => updateDeposit(row._id, "currency", e.target.value)}>
                  <option value="NIS">₪ NIS</option>
                  <option value="USD">$ USD</option>
                </select>
              </Field>
              <Field label="Date">
                <input type="date" value={row.date} max={today()}
                  onChange={e => updateDeposit(row._id, "date", e.target.value)} />
              </Field>
              <div style={{ paddingBottom: 2 }}>
                <button className="cf-iconbtn" style={{ color: "var(--rose)" }}
                  onClick={() => removeDepositRow(row._id)} title="Remove">
                  <Trash2 size={14} strokeWidth={1.6} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="cf-modal-actions" style={{ marginTop: 8 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Creating…" : entryMode === "holding" ? "Add holding" : "Create"}
        </Button>
      </div>
    </div>
  );
}

// ── Edit metadata form ────────────────────────────────────────────────────────

function EditMetaForm({
  investment, onClose, setError,
}: { investment: Investment; onClose: () => void; setError: (e: string | null) => void }) {
  const [name, setName]           = useState(investment.name);
  const [broker, setBroker]       = useState(investment.broker ?? "");
  const [isin, setIsin]           = useState(investment.isin ?? "");
  const [etfKind, setEtfKind]     = useState(investment.etf_kind ?? "");
  const [liquidDate, setLiqDate]  = useState(investment.liquid_date?.slice(0, 10) ?? "");
  const [monthlyDep, setMonthlyDep] = useState(investment.monthly_deposit?.toString() ?? "");
  const [depCcy, setDepCcy]       = useState<Currency>((investment.deposit_currency as Currency) ?? "NIS");

  const editMut  = useEditInvestment();
  const isPending = editMut.isPending;

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    try {
      await editMut.mutateAsync({ id: investment.id, body: {
        name: name.trim(),
        broker: broker.trim() || undefined,
        isin: isin.trim().toUpperCase() || undefined,
        etf_kind: (etfKind || undefined) as "accumulating" | "distributing" | undefined,
        liquid_date: liquidDate || undefined,
        monthly_deposit: monthlyDep ? Number(monthlyDep) : undefined,
        deposit_currency: investment.type === "pension" ? depCcy : undefined,
      }});
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Field label="Name">
        <input value={name} onChange={e => setName(e.target.value)} />
      </Field>

      {(investment.type === "stock" || investment.type === "etf") && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Broker">
              <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="IBKR…" />
            </Field>
            <Field label="ISIN">
              <input value={isin} onChange={e => setIsin(e.target.value.toUpperCase())} placeholder="IE00…" />
            </Field>
          </div>
          {investment.type === "etf" && (
            <Field label="ETF kind">
              <select value={etfKind} onChange={e => setEtfKind(e.target.value)} className="cf-select">
                <option value="">Unknown</option>
                <option value="accumulating">Accumulating (Acc)</option>
                <option value="distributing">Distributing (Dist)</option>
              </select>
            </Field>
          )}
        </>
      )}

      {investment.type === "education" && (
        <Field label="Liquidation date">
          <input type="date" value={liquidDate} onChange={e => setLiqDate(e.target.value)} />
        </Field>
      )}

      {investment.type === "pension" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Monthly deposit" hint="Used to calculate net invested">
            <input type="number" min="0" step="any" value={monthlyDep}
              onChange={e => setMonthlyDep(e.target.value)} placeholder="0" />
          </Field>
          <Field label="Deposit currency">
            <Segment options={CCY_OPTIONS} value={depCcy} onChange={setDepCcy} />
          </Field>
        </div>
      )}

      <div className="cf-modal-actions" style={{ marginTop: 8 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
          {isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ── Shared footer ─────────────────────────────────────────────────────────────

function FormFooter({
  total, currency, onCancel, onSubmit, isPending, submitLabel = "Add transaction",
}: { total: number; currency: Currency; onCancel: () => void; onSubmit: () => void; isPending: boolean; submitLabel?: string }) {
  return (
    <div className="cf-modal-summary">
      <div>
        <div style={{ fontSize: 11, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Total</div>
        <div className="cf-modal-total mono">{fmt(total, { currency })}</div>
      </div>
      <div className="cf-modal-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onSubmit} disabled={isPending}>
          {isPending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </div>
  );
}
