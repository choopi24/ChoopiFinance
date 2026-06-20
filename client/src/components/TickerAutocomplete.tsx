import { useEffect, useRef, useState } from "react";
import { useSymbolSearch, type SymbolHit } from "../hooks/useInvestments";

interface TickerAutocompleteProps {
  value: string;
  onChange: (v: string) => void;
  onSelect: (hit: SymbolHit) => void;
  type: "stock" | "etf" | "crypto";
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Ticker / coin typeahead. The input stays fully usable on its own (you can type
 * a symbol manually); the dropdown is a convenience that fills symbol + name +
 * native currency when a suggestion is picked. Fails soft — if search returns
 * nothing, the field still works as a plain input.
 */
export function TickerAutocomplete({
  value, onChange, onSelect, type, placeholder, autoFocus,
}: TickerAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounce keystrokes before hitting the search endpoint.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 200);
    return () => clearTimeout(t);
  }, [value]);

  const { data: hits = [], isFetching } = useSymbolSearch(debounced, type, open);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const showDropdown = open && value.trim().length >= 2 && (hits.length > 0 || isFetching);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        style={{ textTransform: "uppercase" }}
        autoFocus={autoFocus}
        autoComplete="off"
      />
      {showDropdown && (
        <div className="cf-autocomplete">
          {isFetching && hits.length === 0 && (
            <div className="cf-autocomplete-empty">Searching…</div>
          )}
          {hits.map(h => (
            <button
              type="button"
              key={`${h.symbol}-${h.exchange ?? ""}`}
              className="cf-autocomplete-item"
              onClick={() => { onSelect(h); setOpen(false); }}
            >
              <span className="mono cf-autocomplete-sym">{h.symbol}</span>
              <span className="cf-autocomplete-name">{h.name}</span>
              {h.exchange && <span className="cf-autocomplete-meta">{h.exchange}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
