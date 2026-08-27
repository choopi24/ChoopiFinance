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
import { fmt } from "../lib/fmt";
import type { AssetType, Currency } from "@choopi/shared";
import type { Investment, BulkTransactionRow } from "../hooks/useInvestments";

// ── Constants ─────────────────────────────────────────────────────────────────

const TYPES: { type: AssetType; label: string; desc: string }[] = [
  { type: "crypto",       label: "Crypto",       desc: "Bitcoin, Ethereum, altcoins" },
  { type: "stock",        label: "Stock",        desc: "Equities on any exchange" },
  { type: "etf",          label: "ETF",          desc: "Index funds, UCITS ETFs" },
  { type: "pension",      label: "Pension",      desc: "קרן פנסיה — retirement fund" },
  { type: "gemel",        label: "Gemel",        desc: "קופת גמל — provident fund" },
  { type: "education",    label: "Study fund",   desc: "קרן השתלמות — 6-year savings" },
  { type: "money_market", label: "Money market", desc: "קרן כספית — cash-like fund" },
  { type: "other",        label: "Other",        desc: "Real estate, collectibles, etc." },
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
const MANUAL_TYPES = new Set(["pension", "gemel", "education", "money_market", "other"]);
// Israeli fund types: fee fields apply to these (fund picker removed with the data source).
const IL_FUND_TYPES = new Set(["pension", "gemel", "education"]);
// Manual types that log one-off DEPOSIT rows (pension uses the monthly-deposit model instead).
const DEPOSIT_ROW_TYPES = new Set(["gemel", "education", "money_market", "other"]);

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
        style={{ maxWidth: 520 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="cf-modal-head">
          <div>
            {mode === "add" && (
              <div className="cf-modal-steps">
                <span className={`cf-step-dot ${step === 1 ? "is-on" : "is-done"}`} />
                <span className={`cf-step-dot ${step === 2 ? "is-on" : ""}`} />
              </div>
            )}
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
  const [amount, setAmount]     = useState("");   // money invested (primary path)
  const [units, setUnits]       = useState("");   // optional exact share count
  const [avgPrice, setAvgPrice] = useState("");   // optional, paired with units
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

  async function handleSubmit() {
    setError(null);
    if (!upperTicker) { setError("Ticker is required"); return; }
    if (!date || new Date(date) > new Date()) { setError("Date cannot be in the future"); return; }

    const u   = units !== "" ? Number(units) : null;
    const amt = amount !== "" ? Number(amount) : null;
    const p   = avgPrice !== "" ? Number(avgPrice) : null;

    const hasUnits  = u != null && u > 0;
    const hasAmount = amt != null && amt > 0;
    if (!hasUnits && !hasAmount) {
      setError("Enter the amount you invested, or the number of units you hold."); return;
    }
    if (u != null && (isNaN(u) || u < 0))   { setError("Units must be a non-negative number"); return; }
    if (amt != null && (isNaN(amt) || amt < 0)) { setError("Amount must be a non-negative number"); return; }
    if (p != null && (isNaN(p) || p < 0))   { setError("Average cost cannot be negative"); return; }

    const asOf = new Date(date).toISOString();
    try {
      // Resolve target investment (existing merge target, or a fresh shell).
      let investmentId: number;
      if (existing && !forceSep) {
        investmentId = existing.id;
      } else {
        const inv = await createInv.mutateAsync({
          type,
          name: name.trim() || upperTicker,
          ticker: upperTicker,
          isin: isin.toUpperCase() || undefined,
          broker: broker.trim() || undefined,
        });
        investmentId = inv.id;
      }

      if (hasUnits) {
        // Exact entry: units + the price you paid.
        await addTx.mutateAsync({
          investment_id: investmentId,
          kind: "BUY",
          units: u!,
          price_per_unit: p ?? undefined,
          total_amount: p != null ? u! * p : undefined,
          currency,
          occurred_at: asOf,
          notes: notes.trim() || "Initial holding",
        });
      } else {
        // Amount-only: recorded at cost (no price source to derive units from).
        await addTx.mutateAsync({
          investment_id: investmentId,
          kind: "BUY",
          total_amount: amt!,
          currency,
          occurred_at: asOf,
          notes: notes.trim() || "Initial holding (by amount)",
        });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Footer total: show the amount, or units×price when entered that way.
  const total = amount !== ""
    ? Number(amount || 0)
    : Number(units || 0) * Number(avgPrice || 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {isEtf && (
        <Field label="ISIN (optional)" hint="Recorded for your reference — nothing looks it up">
          <input value={isin} onChange={e => setIsin(e.target.value.toUpperCase())}
            placeholder="IE00B4L5Y983" />
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label={isCrypto ? "Coin symbol" : "Ticker symbol"} hint="Type to search">
          <input
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            placeholder={"isCrypto ? "}
            style={{ textTransform: "uppercase" }}
            autoComplete="off"
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
            placeholder="Auto-filled from search" />
        </Field>
      </div>

      {existing && !forceSep && (
        <MergeBanner info={existing} onSeparate={() => setForceSep(true)} />
      )}

      {/* Primary: add by money invested */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Amount invested" hint="Recorded at cost — add units + price below for unit tracking">
          <input type="number" min="0" step="any" value={amount}
            onChange={e => setAmount(e.target.value)} placeholder="e.g. 5000" />
        </Field>
        <Field label="Currency">
          <Segment options={CCY_OPTIONS} value={currency} onChange={setCurrency} />
        </Field>
      </div>


      {/* Optional precise entry */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label={isCrypto ? "Units held (optional)" : "Shares held (optional)"} hint="Leave blank to add by amount">
          <input type="number" min="0" step="any" value={units}
            onChange={e => setUnits(e.target.value)} placeholder="—" />
        </Field>
        <Field label="Avg cost per unit" hint="Required if you entered units">
          <input type="number" min="0" step="any" value={avgPrice}
            onChange={e => setAvgPrice(e.target.value)} placeholder="—" />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Acquired as of" hint="Date of acquisition">
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            max={today()} />
        </Field>
        {!isCrypto && (
          <Field label="Broker (optional)">
            <input value={broker} onChange={e => setBroker(e.target.value)} placeholder="IBKR, Saxo…" />
          </Field>
        )}
      </div>

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
      <Field label="Coin symbol" hint="Type to search">
        <input
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            placeholder={"BTC, eth…"}
            style={{ textTransform: "uppercase" }}
            autoComplete="off"
          />
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
        <Field label="ISIN (optional)" hint="Recorded for your reference — nothing looks it up">
          <input value={isin} onChange={e => setIsin(e.target.value.toUpperCase())}
            placeholder="IE00B4L5Y983" />
        </Field>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Ticker symbol" hint="Type to search">
          <input
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            placeholder={"isEtf ? "}
            style={{ textTransform: "uppercase" }}
            autoComplete="off"
          />
        </Field>
        <Field label="Name (optional)">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Auto-filled from search" />
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
  // Monthly contribution model (pension / gemel / education)
  const [monthlyDeposit, setMonthlyDep] = useState("");
  const [depCcy, setDepCcy]             = useState<Currency>("NIS");
  // One-off DEPOSIT rows (holding mode only)
  const [deposits, setDeposits]         = useState<DepositRow[]>([]);
  const [feeDeposit, setFeeDeposit]     = useState("");
  const [feeBalance, setFeeBalance]     = useState("");

  const isIlFund = IL_FUND_TYPES.has(type);

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

    const fDep = feeDeposit !== "" ? Number(feeDeposit) : undefined;
    const fBal = feeBalance !== "" ? Number(feeBalance) : undefined;
    if (fDep !== undefined && (isNaN(fDep) || fDep < 0 || fDep > 15)) { setError("Deposit fee must be 0–15%"); return; }
    if (fBal !== undefined && (isNaN(fBal) || fBal < 0 || fBal > 5))  { setError("Balance fee must be 0–5%/yr"); return; }

    try {
      const inv = await createInv.mutateAsync({
        type,
        name: cleanName,
        initial_balance: balance ? Number(balance) : undefined,
        currency,
        liquid_date: type === "education" && liquidDate ? liquidDate : undefined,
        occurred_at: new Date(date).toISOString(),
        monthly_deposit: isIlFund && entryMode === "holding" ? md : undefined,
        deposit_currency: isIlFund && entryMode === "holding" ? depCcy : undefined,
        fee_deposit_pct: isIlFund ? fDep : undefined,
        fee_balance_pct: isIlFund ? fBal : undefined,
      });

      // Non-pension manual funds in holding mode: add DEPOSIT rows via bulk endpoint
      if (entryMode === "holding" && DEPOSIT_ROW_TYPES.has(type) && deposits.length > 0) {
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
      {isIlFund ? (
        <Field label="Fund name" hint="Type the Hebrew name to search the regulator's fund list (מסלול-specific)">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="הפניקס גמל, מנורה פנסיה…"
            dir="auto"
            autoComplete="off"
            autoFocus
          />
        </Field>
      ) : (
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder={
            type === "money_market" ? "קרן כספית שקלית…" : "Wine collection"
          } />
        </Field>
      )}

      {isIlFund && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Fee on deposits (%)" hint="דמי ניהול מהפקדה — from your statement">
            <input type="number" min="0" max="15" step="any" value={feeDeposit}
              onChange={e => setFeeDeposit(e.target.value)} placeholder="e.g. 1.5" />
          </Field>
          <Field label="Fee on balance (%/yr)" hint="דמי ניהול מצבירה">
            <input type="number" min="0" max="5" step="any" value={feeBalance}
              onChange={e => setFeeBalance(e.target.value)} placeholder="e.g. 0.6" />
          </Field>
        </div>
      )}

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

      {/* IL funds: expected monthly contribution (holding mode only) */}
      {isIlFund && entryMode === "holding" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Monthly deposit" hint="Expected contribution — used for net invested & estimates">
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

      {/* Non-pension manual funds: initial DEPOSIT rows (holding mode only) */}
      {entryMode === "holding" && DEPOSIT_ROW_TYPES.has(type) && (
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
  const [feeDeposit, setFeeDeposit] = useState(investment.fee_deposit_pct?.toString() ?? "");
  const [feeBalance, setFeeBalance] = useState(investment.fee_balance_pct?.toString() ?? "");

  const isIlFund = IL_FUND_TYPES.has(investment.type);

  const editMut  = useEditInvestment();
  const isPending = editMut.isPending;

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    try {
      // Empty inputs send explicit null (clear the field). `undefined` keys are
      // dropped by JSON.stringify, which made clearing impossible — the server
      // never saw the field and the old value silently survived.
      await editMut.mutateAsync({ id: investment.id, body: {
        name: name.trim(),
        broker: broker.trim() || null,
        isin: isin.trim().toUpperCase() || null,
        etf_kind: (etfKind || null) as "accumulating" | "distributing" | null,
        liquid_date: liquidDate || null,
        monthly_deposit: monthlyDep === "" ? null : Number(monthlyDep),
        deposit_currency: isIlFund ? depCcy : undefined,
        fee_deposit_pct: isIlFund ? (feeDeposit !== "" ? Number(feeDeposit) : null) : undefined,
        fee_balance_pct: isIlFund ? (feeBalance !== "" ? Number(feeBalance) : null) : undefined,
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

      {isIlFund && (
        <>
          {investment.fund_track && (
            <div className="cf-quote-preview" dir="auto">
              Linked fund: {investment.fund_track}
              {investment.fund_id != null && <span className="mono"> · #{investment.fund_id}</span>}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Monthly deposit" hint="Expected contribution — used for net invested & estimates">
              <input type="number" min="0" step="any" value={monthlyDep}
                onChange={e => setMonthlyDep(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Deposit currency">
              <Segment options={CCY_OPTIONS} value={depCcy} onChange={setDepCcy} />
            </Field>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Fee on deposits (%)" hint="דמי ניהול מהפקדה">
              <input type="number" min="0" max="15" step="any" value={feeDeposit}
                onChange={e => setFeeDeposit(e.target.value)} placeholder="e.g. 1.5" />
            </Field>
            <Field label="Fee on balance (%/yr)" hint="דמי ניהול מצבירה">
              <input type="number" min="0" max="5" step="any" value={feeBalance}
                onChange={e => setFeeBalance(e.target.value)} placeholder="e.g. 0.6" />
            </Field>
          </div>
        </>
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
