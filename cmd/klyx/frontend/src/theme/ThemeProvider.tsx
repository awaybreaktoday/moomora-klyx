import { createContext, useContext, useEffect, useState, ReactNode } from "react";

type Theme = "light" | "dark";
type Ctx = { theme: Theme; toggle: () => void };

const ThemeContext = createContext<Ctx | null>(null);

const STORAGE_KEY = "klyx-theme";

function initial(): Theme {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "dark" ? "dark" : "light";
}

// toggleTheme flips the active theme using the same storage key and DOM
// attribute the provider manages, for callers outside the React tree (e.g. the
// command palette). The provider, when mounted, picks up the persisted value on
// next read; both paths agree on STORAGE_KEY + data-theme so state stays
// consistent. Returns the new theme.
export function toggleTheme(): Theme {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next: Theme = current === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(STORAGE_KEY, next);
  return next;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggle = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Ctx {
  const c = useContext(ThemeContext);
  if (!c) throw new Error("useTheme must be used within ThemeProvider");
  return c;
}
