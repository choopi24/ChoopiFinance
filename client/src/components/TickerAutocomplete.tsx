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
  const [active, setActive] = useState(-1); // keyboard-highlighted row
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounce keystrokes before hitting the search endpoint.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 200);
    return () => clearTimeout(t);
  }, [value]);

  const { data: hits = [], isFetching } = useSymbolSearch(debounced, type, open);

  // Reset the highlight whenever the result set changes.
  useEffect(() => { setActive(-1); }, [debounced, hits.length]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const showDropdown = open && value.trim().length >= 2 && (hits.length > 0 || isFetching);

  function pick(hit: SymbolHit) {
    onSelect(hit);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { setOpen(false); return; }
    if (!showDropdown || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(i => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(i => (i <= 0 ? hits.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(hits[active]);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <input
        value={value}
        onChange={e => { onChange(e.target.value.toUpperCase()); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ textTransform: "uppercase" }}
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        aria-controls="cf-ticker-listbox"
        aria-activedescendant={active >= 0 ? `cf-ticker-opt-${active}` : undefined}
      />
      {showDropdown && (
        <div className="cf-autocomplete" id="cf-ticker-listbox" role="listbox">
          {isFetching && hits.length === 0 && (
            <div className="cf-autocomplete-empty">Searching…</div>
          )}
          {hits.map((h, i) => (
            <button
              type="button"
              id={`cf-ticker-opt-${i}`}
              role="option"
              aria-selected={i === active}
              key={`${h.symbol}-${h.exchange ?? ""}`}
              className={`cf-autocomplete-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(h)}
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
