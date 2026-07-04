import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Upload, Download, CheckCircle, AlertCircle, ChevronRight, Info } from "lucide-react";
import { useCsvPreview, useCsvImport, useCsvMatrixPreview, useCsvMatrixImport } from "../hooks/useSettings";
import type { FundPreview } from "../hooks/useSettings";
import { useNavigate } from "react-router-dom";

// ── Template definitions ──────────────────────────────────────────────────────

type AssetType = "crypto" | "stock" | "etf" | "pension" | "gemel" | "education" | "money_market" | "other";

const MANUAL_TYPES = new Set<AssetType>(["pension", "gemel", "education", "money_market", "other"]);

interface TypeCard {
  id: AssetType;
  label: string;
  icon: string;
  headers: string[];
  example: string[];
}

const TYPE_CARDS: TypeCard[] = [
  {
    id: "crypto", label: "Crypto", icon: "₿",
    headers: ["ticker", "wallet", "units", "price_per_unit", "currency", "date", "kind", "exchange", "notes"],
    example:  ["BTC",    "hw-wallet", "0.05", "180000",         "NIS",      "2024-01-15", "BUY",  "Binance", ""],
  },
  {
    id: "stock", label: "Stocks", icon: "📈",
    headers: ["ticker", "shares", "price_per_share", "currency", "broker", "date", "kind", "notes"],
    example:  ["AAPL",   "10",     "185.50",          "USD",      "IBI",    "2024-01-20", "BUY",  ""],
  },
  {
    id: "etf", label: "ETF", icon: "🌐",
    headers: ["ticker", "isin",           "etf_kind",      "shares", "price_per_share", "currency", "broker", "date", "kind", "notes"],
    example:  ["VWCE",   "IE00B3RBWM25", "accumulating", "5",      "110.20",           "USD",      "IBI",    "2024-01-25", "BUY",  ""],
  },
  {
    id: "pension", label: "Pension", icon: "🏦",
    headers: ["name",          "balance", "currency", "date"],
    example:  ["My Pension",   "150000",  "NIS",      "2024-01-01"],
  },
  {
    id: "gemel", label: "Gemel", icon: "🏛️",
    headers: ["name",              "balance", "currency", "date"],
    example:  ["קופת גמל הפניקס", "80000",   "NIS",      "2024-01-01"],
  },
  {
    id: "education", label: "Study fund", icon: "🎓",
    headers: ["name",            "balance", "currency", "date",       "liquid_date"],
    example:  ["Savings Fund",   "30000",   "NIS",      "2024-01-01", "2030-09-01"],
  },
  {
    id: "money_market", label: "Money market", icon: "💵",
    headers: ["name",              "balance", "currency", "date"],
    example:  ["קרן כספית שקלית", "50000",   "NIS",      "2024-01-01"],
  },
  {
    id: "other", label: "Other", icon: "💼",
    headers: ["name",        "category",   "invested_amount", "currency", "date",       "notes"],
    example:  ["Art piece",  "Collectible", "5000",           "USD",      "2024-01-01", ""],
  },
];

function downloadTemplate(card: TypeCard) {
  const BOM = "﻿";
  const header = card.headers.join(",");
  const example = card.example.map(v => v.includes(",") ? `"${v}"` : v).join(",");
  const csv = BOM + [header, example].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${card.id}-template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadMatrixTemplate() {
  const BOM = "﻿";
  const lines = [
    "Fund A Name,Fund B Name,Fund C Name,",
    "10000,5000,25000,1.1.24",
    "10500,5200,25800,1.4.24",
    "11200,5500,27000,1.7.24",
  ];
  const csv = BOM + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "fund-matrix-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

export function CsvImportModal({ onClose }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedType, setSelectedType] = useState<AssetType | null>(null);
  const [csvContent, setCsvContent] = useState<string>("");
  const [fileName, setFileName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [fundEdits, setFundEdits] = useState<Array<{ name: string; type: string }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const preview = useCsvPreview();
  const importCsv = useCsvImport();
  const matrixPreview = useCsvMatrixPreview();
  const matrixImport = useCsvMatrixImport();

  const isManualType = selectedType !== null && MANUAL_TYPES.has(selectedType);

  function handleFile(file: File) {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = (e.target?.result as string) || "";
      setCsvContent(text.replace(/^﻿/, "")); // strip BOM
    };
    reader.readAsText(file, "utf-8");
  }

  function updateFundEdit(idx: number, field: "name" | "type", value: string) {
    setFundEdits(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  }

  async function runPreview() {
    if (!selectedType || !csvContent) return;
    if (isManualType) {
      const result = await matrixPreview.mutateAsync({ content: csvContent });
      setFundEdits(result.funds.map(f => ({ name: f.suggestedName, type: f.detectedType })));
      setStep(2);
    } else {
      await preview.mutateAsync({ type: selectedType, content: csvContent });
      setStep(2);
    }
  }

  async function runImport() {
    if (!selectedType || !csvContent) return;
    if (isManualType && matrixPreview.data) {
      const funds = matrixPreview.data.funds.map((f, i) => ({
        originalName: f.originalName,
        name: fundEdits[i]?.name || f.suggestedName,
        type: fundEdits[i]?.type || f.detectedType,
      }));
      await matrixImport.mutateAsync({ content: csvContent, funds });
    } else {
      await importCsv.mutateAsync({ type: selectedType, content: csvContent });
    }
    setStep(3);
  }

  const previewData  = preview.data;
  const hasErrors    = isManualType
    ? (matrixPreview.data?.errors?.length ?? 0) > 0
    : (previewData?.errors?.length ?? 0) > 0;
  const importResult = isManualType ? matrixImport.data : importCsv.data;
  const previewErrorMsg = isManualType
    ? (matrixPreview.isError ? String((matrixPreview as any).error?.message ?? "Preview failed") : null)
    : (preview.isError ? String((preview as any).error?.message ?? "Preview failed") : null);
  const importPending = isManualType ? matrixImport.isPending : importCsv.isPending;
  const previewPending = isManualType ? matrixPreview.isPending : preview.isPending;

  return createPortal(
    <div className="cf-modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="cf-csv-modal">

        {/* Header */}
        <div className="cf-csv-modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Import from CSV</h2>
            <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>
              Step {step} of 3 — {step === 1 ? "Choose type & upload" : step === 2 ? "Preview & validate" : "Done"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-faint)", padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Step 1: type picker + upload ─────────────────────────────────── */}
        {step === 1 && (
          <div style={{ padding: "20px 24px 24px" }}>
            <p style={{ fontSize: 13, color: "var(--text-faint)", margin: "0 0 16px" }}>
              Select the asset type you want to import.
            </p>
            <div className="cf-csv-type-grid">
              {TYPE_CARDS.map(card => (
                <div
                  key={card.id}
                  className={["cf-csv-type-card", selectedType === card.id ? "is-selected" : ""].filter(Boolean).join(" ")}
                  onClick={() => { setSelectedType(card.id); matrixPreview.reset(); preview.reset(); }}
                >
                  <div className="cf-csv-type-icon">{card.icon}</div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{card.label}</div>
                  {!MANUAL_TYPES.has(card.id) && (
                    <button
                      className="cf-csv-template-link"
                      onClick={e => { e.stopPropagation(); downloadTemplate(card); }}
                      title="Download template"
                    >
                      <Download size={11} /> Template
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Matrix format instructions for manual types */}
            {selectedType && MANUAL_TYPES.has(selectedType) && (
              <div className="cf-matrix-info" style={{ marginTop: 16 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                  <Info size={14} />
                  <strong style={{ fontSize: 12 }}>Wide matrix format</strong>
                  <button
                    className="cf-csv-template-link"
                    style={{ marginLeft: "auto" }}
                    onClick={downloadMatrixTemplate}
                  >
                    <Download size={11} /> Example
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.5 }}>
                  Each column = one fund. Last column = snapshot date (D.M.YY).
                  Empty cells are skipped — no need to fill every date for every fund.
                </div>
                <div className="cf-matrix-example">
                  <table>
                    <thead>
                      <tr><th>Pension Fund</th><th>Education Fund</th><th></th></tr>
                    </thead>
                    <tbody>
                      <tr><td>₪34,270</td><td>₪11,439</td><td>23.9.23</td></tr>
                      <tr><td>₪43,893</td><td>₪12,463</td><td>21.3.24</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {selectedType && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 8 }}>
                  Upload your CSV file
                </div>
                <div
                  className={["cf-dropzone", dragOver ? "is-over" : ""].filter(Boolean).join(" ")}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files[0];
                    if (f) handleFile(f);
                  }}
                >
                  <Upload size={24} style={{ color: "var(--text-faint)", marginBottom: 8 }} />
                  {fileName
                    ? <><strong>{fileName}</strong><br /><span style={{ fontSize: 12, color: "var(--text-faint)" }}>Click to replace</span></>
                    : <><strong>Drop CSV here</strong><br /><span style={{ fontSize: 12, color: "var(--text-faint)" }}>or click to browse</span></>
                  }
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                />
              </div>
            )}

            {previewErrorMsg && (
              <div className="cf-modal-error" style={{ marginTop: 12 }}>{previewErrorMsg}</div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20, gap: 8 }}>
              <button className="cf-btn cf-btn-ghost" onClick={onClose}>Cancel</button>
              <button
                className="cf-btn cf-btn-grad"
                disabled={!selectedType || !csvContent || previewPending}
                onClick={runPreview}
              >
                {previewPending ? "Validating…" : <>Preview <ChevronRight size={14} /></>}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2 (matrix): fund editor ─────────────────────────────────── */}
        {step === 2 && isManualType && matrixPreview.data && (
          <div style={{ padding: "20px 24px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Summary banner */}
            {(() => {
              const d = matrixPreview.data;
              const totalSnaps = d.funds.reduce((s, f) => s + f.snapshotCount, 0);
              return (
                <div className={["cf-csv-summary", hasErrors ? "is-error" : "is-ok"].join(" ")}>
                  {hasErrors
                    ? <><AlertCircle size={16} /> <strong>{d.errors.length}</strong> error{d.errors.length !== 1 ? "s" : ""} found — fix the CSV and re-upload</>
                    : <><CheckCircle size={16} /> <strong>{d.funds.length}</strong> fund{d.funds.length !== 1 ? "s" : ""} · <strong>{totalSnaps}</strong> snapshot{totalSnaps !== 1 ? "s" : ""} ready</>
                  }
                  {d.skipped_cells > 0 && (
                    <span className="cf-skipped-note">
                      · {d.skipped_cells} empty cell{d.skipped_cells !== 1 ? "s" : ""} skipped
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Errors */}
            {matrixPreview.data.errors.length > 0 && (
              <div className="cf-csv-errors">
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Validation errors</div>
                {matrixPreview.data.errors.slice(0, 20).map((e, i) => (
                  <div key={i} className="cf-csv-error-row">
                    <span className="cf-csv-error-row-num">Row {e.row}</span>
                    <span className="cf-csv-error-field">{e.field}</span>
                    <span>{e.message}</span>
                  </div>
                ))}
                {matrixPreview.data.errors.length > 20 && (
                  <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 8 }}>
                    …and {matrixPreview.data.errors.length - 20} more errors
                  </div>
                )}
              </div>
            )}

            {/* Fund edit rows */}
            {!hasErrors && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 10, color: "var(--text-faint)" }}>
                  Review & rename funds before importing
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {matrixPreview.data.funds.map((f: FundPreview, i: number) => (
                    <FundEditRow
                      key={i}
                      index={i}
                      fund={f}
                      name={fundEdits[i]?.name ?? f.suggestedName}
                      type={fundEdits[i]?.type ?? f.detectedType}
                      onNameChange={v => updateFundEdit(i, "name", v)}
                      onTypeChange={v => updateFundEdit(i, "type", v)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button className="cf-btn cf-btn-ghost" onClick={() => setStep(1)}>← Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="cf-btn cf-btn-ghost" onClick={onClose}>Cancel</button>
                <button
                  className="cf-btn cf-btn-grad"
                  disabled={hasErrors || importPending}
                  onClick={runImport}
                >
                  {importPending ? "Importing…" : "Confirm import"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2 (market): preview table ───────────────────────────────── */}
        {step === 2 && !isManualType && previewData && (
          <div style={{ padding: "20px 24px 24px", display: "flex", flexDirection: "column", gap: 16 }}>

            <div className={["cf-csv-summary", hasErrors ? "is-error" : "is-ok"].join(" ")}>
              {hasErrors
                ? <><AlertCircle size={16} /> <strong>{previewData.rows_invalid}</strong> row{previewData.rows_invalid !== 1 ? "s" : ""} failed — fix and re-upload</>
                : <><CheckCircle size={16} /> <strong>{previewData.rows_valid}</strong> row{previewData.rows_valid !== 1 ? "s" : ""} valid — ready to import</>
              }
            </div>

            {previewData.errors.length > 0 && (
              <div className="cf-csv-errors">
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Validation errors</div>
                {previewData.errors.slice(0, 20).map((e, i) => (
                  <div key={i} className="cf-csv-error-row">
                    <span className="cf-csv-error-row-num">Row {e.row}</span>
                    <span className="cf-csv-error-field">{e.field}</span>
                    <span>{e.message}</span>
                  </div>
                ))}
                {previewData.errors.length > 20 && (
                  <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 8 }}>
                    …and {previewData.errors.length - 20} more errors
                  </div>
                )}
              </div>
            )}

            {!hasErrors && previewData.preview_rows.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8 }}>Preview (first {previewData.preview_rows.length} rows)</div>
                <table className="cf-tx-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      {Object.keys(previewData.preview_rows[0]).map(h => (
                        <th key={h} scope="col">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.preview_rows.map((row, i) => (
                      <tr key={i}>
                        {Object.values(row).map((v, j) => (
                          <td key={j}>{v || <span style={{ color: "var(--text-faint)" }}>—</span>}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {previewErrorMsg && (
              <div className="cf-modal-error">{previewErrorMsg}</div>
            )}

            <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
              <button className="cf-btn cf-btn-ghost" onClick={() => setStep(1)}>← Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="cf-btn cf-btn-ghost" onClick={onClose}>Cancel</button>
                <button
                  className="cf-btn cf-btn-grad"
                  disabled={hasErrors || importPending}
                  onClick={runImport}
                >
                  {importPending ? "Importing…" : "Confirm import"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: success ───────────────────────────────────────────────── */}
        {step === 3 && importResult && (
          <div style={{ padding: "40px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>Import complete</h3>
            <p style={{ color: "var(--text-faint)", fontSize: 13, margin: "0 0 24px" }}>
              Created <strong>{importResult.investments_created}</strong> investment{importResult.investments_created !== 1 ? "s" : ""} and{" "}
              <strong>{importResult.transactions_created}</strong> transaction{importResult.transactions_created !== 1 ? "s" : ""}.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="cf-btn cf-btn-ghost" onClick={onClose}>Close</button>
              <button
                className="cf-btn cf-btn-grad"
                onClick={() => {
                  onClose();
                  navigate(isManualType ? "/investments" : `/investments?type=${selectedType}`);
                }}
              >
                View investments
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── FundEditRow subcomponent ──────────────────────────────────────────────────

interface FundEditRowProps {
  index: number;
  fund: FundPreview;
  name: string;
  type: string;
  onNameChange: (v: string) => void;
  onTypeChange: (v: string) => void;
}

function FundEditRow({ index, fund, name, type, onNameChange, onTypeChange }: FundEditRowProps) {
  const gainColor = fund.gain >= 0 ? "var(--emerald)" : "var(--rose)";
  const gainSign  = fund.gain >= 0 ? "+" : "";

  return (
    <div className="cf-fund-edit-row">
      <div className="cf-fund-edit-header">
        <span className="cf-fund-edit-index">{index + 1}</span>
        <div className="cf-fund-edit-fields">
          <input
            className="cf-input"
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder="Fund name"
            style={{ flex: 1, minWidth: 0 }}
          />
          <select
            className="cf-select"
            value={type}
            onChange={e => onTypeChange(e.target.value)}
            style={{ width: 130, flexShrink: 0 }}
          >
            <option value="pension">Pension</option>
            <option value="gemel">Gemel</option>
            <option value="education">Study fund</option>
            <option value="money_market">Money market</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div className="cf-fund-edit-meta">
        <span>{fund.snapshotCount} snapshot{fund.snapshotCount !== 1 ? "s" : ""}</span>
        {fund.earliestDate && fund.latestDate && (
          <span>{fund.earliestDate} → {fund.latestDate}</span>
        )}
        {fund.latestValue > 0 && (
          <span>₪{fmt(fund.latestValue)}</span>
        )}
        {fund.snapshotCount > 1 && (
          <span style={{ color: gainColor, fontWeight: 600 }}>
            {gainSign}{fund.gainPct.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
