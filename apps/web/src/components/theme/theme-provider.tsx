import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import {
  parseThemeMode,
  type ResolvedTheme,
  type ThemeMode,
} from "@homepage/domain";

export const THEME_STORAGE_KEY = "homepage-theme";

export type ThemeContextValue = {

  theme: ThemeMode;

  resolvedTheme: ResolvedTheme;

  setTheme: (mode: ThemeMode) => void;
};

// HMR 下模块重执行会新建 Context；挂 globalThis 保持 Provider/useTheme 同一引用
const THEME_CONTEXT_GLOBAL_KEY = "__homepage_theme_context__" as const;

type ThemeContextType = ReturnType<
  typeof createContext<ThemeContextValue | null>
>;

type ThemeContextGlobal = typeof globalThis & {
  [THEME_CONTEXT_GLOBAL_KEY]?: ThemeContextType;
};

function getThemeContext(): ThemeContextType {
  const g = globalThis as ThemeContextGlobal;
  const existing = g[THEME_CONTEXT_GLOBAL_KEY];
  if (existing) {
    return existing;
  }
  const created = createContext<ThemeContextValue | null>(null);
  g[THEME_CONTEXT_GLOBAL_KEY] = created;
  return created;
}

const ThemeContext = getThemeContext();

function getSystemResolved(): ResolvedTheme {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  return getSystemResolved();
}

export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

export function readStoredThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function writeStoredThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* private mode / 配额等 */
  }
}

export type ThemeProviderProps = {
  children: ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps): JSX.Element {
  const [theme, setThemeState] = useState<ThemeMode>(() =>
    readStoredThemeMode(),
  );
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveThemeMode(readStoredThemeMode()),
  );

  const setTheme = useCallback((mode: ThemeMode) => {
    const next = parseThemeMode(mode);
    setThemeState(next);
    writeStoredThemeMode(next);
    const resolved = resolveThemeMode(next);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, []);

  useEffect(() => {
    const resolved = resolveThemeMode(theme);
    setResolvedTheme(resolved);
    applyResolvedTheme(resolved);
  }, [theme]);

  // system 模式监听 OS；手动模式卸载监听
  useEffect(() => {
    if (theme !== "system") {
      return;
    }
    if (typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const syncFromSystem = (): void => {
      const resolved = getSystemResolved();
      setResolvedTheme(resolved);
      applyResolvedTheme(resolved);
    };

    syncFromSystem();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", syncFromSystem);
      return () => {
        media.removeEventListener("change", syncFromSystem);
      };
    }

    // 旧版 Safari
    media.addListener(syncFromSystem);
    return () => {
      media.removeListener(syncFromSystem);
    };
  }, [theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
    }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme 必须在 ThemeProvider 内使用");
  }
  return ctx;
}
