import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyThemePreference,
  readThemePreference,
  storeThemePreference,
  type ThemePreference,
} from "./preference";

interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** Holds the colour scheme choice, applies it to the document and remembers it. */
export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyThemePreference(preference, document.documentElement);
    storeThemePreference(preference);
  }, [preference]);

  const value = useMemo(() => ({ preference, setPreference }), [preference]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The current colour scheme choice and its setter. Throws outside a {@link ThemeProvider}. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === undefined) throw new Error("useTheme needs a ThemeProvider");
  return value;
}
