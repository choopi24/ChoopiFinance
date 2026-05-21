import { useState, useEffect, useCallback } from "react";
import type { Theme } from "@choopi/shared";
import { api } from "../lib/api";

const STORAGE_KEY = "cf-theme";

type ThemeMode = "light" | "dark" | "system";

function resolveTheme(mode: ThemeMode): Theme {
  if (mode === "system") {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function useTheme(): [Theme, () => void, ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode;
      if (saved === "light" || saved === "dark" || saved === "system") return saved;
    } catch { /* ignore */ }
    return "system";
  });

  const theme = resolveTheme(mode);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  }, [theme, mode]);

  // Keep in sync if system preference changes while mode === "system"
  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => document.documentElement.setAttribute("data-theme", resolveTheme("system"));
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((m) => {
      const next = m === "light" ? "dark" : "light";
      api.patch("/settings/theme", { theme: next }).catch(() => {/* best effort */});
      return next;
    });
  }, []);

  const setThemeMode = useCallback((m: ThemeMode) => {
    setMode(m);
    api.patch("/settings/theme", { theme: m }).catch(() => {/* best effort */});
  }, []);

  return [theme, toggle, mode, setThemeMode];
}
