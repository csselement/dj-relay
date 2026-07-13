import { ConfigProvider, theme as antTheme, type ThemeConfig } from "antd";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

export type ThemeName = "dark" | "light";

const STORAGE_KEY = "dj-relay-theme";
const THEME_COLORS: Record<ThemeName, string> = {
  dark: "#171715",
  light: "#f7f6f2",
};

function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The selected theme still applies for this page when storage is unavailable.
  }
}

type ThemeContextValue = {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  setTheme: applyTheme,
});

const palettes = {
  dark: {
    canvas: "#171715",
    surface: "#1f1f1c",
    elevated: "#272723",
    text: "#f3f2ed",
    textSecondary: "#a5a49e",
    border: "#343430",
    fieldBorder: "#4a4943",
    primary: "#efeee9",
    primaryHover: "#ffffff",
    solidText: "#252523",
    success: "#9abb9b",
    error: "#e28f8c",
    warning: "#d5b873",
  },
  light: {
    canvas: "#f7f6f2",
    surface: "#ffffff",
    elevated: "#f1f0eb",
    text: "#242422",
    textSecondary: "#6f6e69",
    border: "#eaeaea",
    fieldBorder: "#d8d7d1",
    primary: "#242422",
    primaryHover: "#393936",
    solidText: "#ffffff",
    success: "#346538",
    error: "#9f2f2d",
    warning: "#956400",
  },
} as const;

export function DesignSystemProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(currentTheme);

  const setTheme = useCallback((nextTheme: ThemeName) => {
    applyTheme(nextTheme);
    setThemeState(nextTheme);
  }, []);

  const config = useMemo<ThemeConfig>(() => {
    const palette = palettes[theme];
    return {
      algorithm: theme === "dark" ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
      cssVar: { key: `dj-relay-${theme}` },
      token: {
        colorPrimary: palette.primary,
        colorPrimaryHover: palette.primaryHover,
        colorBgBase: palette.canvas,
        colorBgContainer: palette.surface,
        colorBgElevated: palette.elevated,
        colorText: palette.text,
        colorTextSecondary: palette.textSecondary,
        colorBorder: palette.fieldBorder,
        colorBorderSecondary: palette.border,
        colorTextLightSolid: palette.solidText,
        colorSuccess: palette.success,
        colorError: palette.error,
        colorWarning: palette.warning,
        borderRadius: 6,
        borderRadiusLG: 8,
        controlHeight: 42,
        controlHeightLG: 50,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif',
        boxShadow: "none",
        boxShadowSecondary: "none",
      },
      components: {
        Button: {
          primaryShadow: "none",
          dangerShadow: "none",
          defaultShadow: "none",
          fontWeight: 680,
        },
        Card: {
          bodyPadding: 24,
          bodyPaddingSM: 18,
        },
        Input: {
          activeShadow: `0 0 0 3px ${theme === "dark" ? "#334033" : "#dfe8dc"}`,
        },
        Select: {
          activeOutlineColor: theme === "dark" ? "#334033" : "#dfe8dc",
        },
      },
    };
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [setTheme, theme]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider componentSize="large" theme={config} wave={{ disabled: true }}>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
