import { useEffect, useRef, useState } from "react";
import { useIlFundSearch, type IlFundHit } from "../hooks/useInvestments";

interface IlFundAutocompleteProps {
  value: string;
  onChange: (v: string) => void;
  onSelect: (hit: IlFundHit) => void;
  /** pension | gemel | education — picks the regulator dataset server-side. */
  type: string;
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * Israeli fund typeahead over Gemel-Net / Pensia-Net. Like TickerAutocomplete,
 * the input works standalone (type any name); picking a suggestion links the
 * investment to the regulator fund (id + track) and fills the official fees.
 * Hebrew input, RTL-friendly.
 */
export function IlFundAutocomplete({
  value, onChange, onSelect, type, placeholder, autoFocus,
}: IlFundAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 250);
    return () => clearTimeout(t);
  }, [value]);

  const { data: hits = [], isFetching } = useIlFundSearch(debounced, type, open);

  useEffect(() => { setActive(-1); }, [debounced, hits.length]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const showDropdown = open && value.trim().length >= 2 && (hits.length > 0 || isFetching);

  function pick(hit: IlFundHit) {
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
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        dir="auto"
        autoFocus={autoFocus}
        autoComplete="off"
        role="combobox"
        aria-expanded={showDropdown}
        aria-autocomplete="list"
        aria-controls="cf-ilfund-listbox"
        aria-activedescendant={active >= 0 ? `cf-ilfund-opt-${active}` : undefined}
      />
      {showDropdown && (
        <div className="cf-autocomplete" id="cf-ilfund-listbox" role="listbox">
          {isFetching && hits.length === 0 && (
            <div className="cf-autocomplete-empty">Searching the regulator's fund list…</div>
          )}
          {hits.map((h, i) => (
            <button
              type="button"
              id={`cf-ilfund-opt-${i}`}
              role="option"
              aria-selected={i === active}
              key={h.fund_id}
              className={`cf-autocomplete-item${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(h)}
            >
              <span className="cf-autocomplete-name" dir="rtl" style={{ textAlign: "right", flex: 1 }}>
                {h.name}
              </span>
              <span className="cf-autocomplete-meta mono">
                #{h.fund_id}
                {h.avg_annual_mgmt_fee != null && ` · ${h.avg_annual_mgmt_fee}%`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
