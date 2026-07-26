import { createContext, useContext, useEffect, useState } from "react";

// Same palette as the mobile ThemeContext, applied as CSS custom properties.
export const light = {
  bg: "#F7F8FC",
  card: "#FFFFFF",
  text: "#1a1a2e",
  subtext: "#9ca3af",
  border: "#ececf3",
  inputBg: "#F7F8FC",
  pillBg: "#FFFFFF",
  pillActiveBg: "#1a1a2e",
  pillActiveText: "#FFFFFF",
  accent: "#007BFF",
  divider: "#f1f1f6",
  sidebar: "#FFFFFF",
  shadow: "0 2px 12px rgba(16, 24, 40, 0.06)",
  shadowLg: "0 8px 30px rgba(16, 24, 40, 0.10)",
};

export const dark = {
  bg: "#0f1117",
  card: "#1c1f2e",
  text: "#f0f0f0",
  subtext: "#8b90a3",
  border: "#2a2d3e",
  inputBg: "#252838",
  pillBg: "#1c1f2e",
  pillActiveBg: "#f0f0f0",
  pillActiveText: "#1a1a2e",
  accent: "#3b82f6",
  divider: "#2a2d3e",
  sidebar: "#141724",
  shadow: "0 2px 12px rgba(0, 0, 0, 0.35)",
  shadowLg: "0 8px 30px rgba(0, 0, 0, 0.5)",
};

const STORAGE_KEY = "airflow_theme";
const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  });

  const theme = isDark ? dark : light;

  // Push the palette onto :root so plain CSS can use var(--card) etc.
  useEffect(() => {
    const root = document.documentElement;
    Object.entries(theme).forEach(([k, v]) => root.style.setProperty(`--${k}`, v));
    root.style.colorScheme = isDark ? "dark" : "light";
    localStorage.setItem(STORAGE_KEY, isDark ? "dark" : "light");
  }, [theme, isDark]);

  const toggleTheme = () => setIsDark((p) => !p);

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
