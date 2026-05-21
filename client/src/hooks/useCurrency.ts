import { useState, useCallback } from "react";
import type { Currency } from "@choopi/shared";
import { api } from "../lib/api";

const STORAGE_KEY = "cf-currency";

export function useCurrency(): [Currency, (c: Currency) => void] {
  const [currency, setCurrencyState] = useState<Currency>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Currency;
      if (saved === "NIS" || saved === "USD") return saved;
    } catch { /* ignore */ }
    return "NIS";
  });

  const setCurrency = useCallback((c: Currency) => {
    setCurrencyState(c);
    try { localStorage.setItem(STORAGE_KEY, c); } catch { /* ignore */ }
    api.patch("/settings/display-currency", { currency: c }).catch(() => {/* best effort */});
  }, []);

  return [currency, setCurrency];
}
