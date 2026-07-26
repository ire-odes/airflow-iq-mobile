import React, { createContext, useContext, useEffect, useState } from "react";
import { Appearance } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

const THEME_STORAGE_KEY = "app_theme_preference"; // "light" | "dark"

export const light = {
  bg: "#F7F8FC",
  card: "#FFFFFF",
  text: "#1a1a2e",
  subtext: "#9ca3af",
  border: "#f0f0f0",
  inputBg: "#F7F8FC",
  pillBg: "#FFFFFF",
  pillActiveBg: "#1a1a2e",
  pillActiveText: "#FFFFFF",
  accent: "#007BFF",
  divider: "#f5f5f5",
};

export const dark = {
  bg: "#0f1117",
  card: "#1c1f2e",
  text: "#f0f0f0",
  subtext: "#6b7280",
  border: "#2a2d3e",
  inputBg: "#252838",
  pillBg: "#1c1f2e",
  pillActiveBg: "#f0f0f0",
  pillActiveText: "#1a1a2e",
  accent: "#3b82f6",
  divider: "#2a2d3e",
};

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(Appearance.getColorScheme() === "dark");

  // Restore the saved preference; fall back to the system scheme
  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((saved) => {
        if (saved === "dark") setIsDark(true);
        else if (saved === "light") setIsDark(false);
      })
      .catch((e) => console.warn("Theme load failed:", e.message));
  }, []);

  const theme = isDark ? dark : light;

  const toggleTheme = () => {
    setIsDark((prev) => {
      const next = !prev;
      AsyncStorage.setItem(THEME_STORAGE_KEY, next ? "dark" : "light")
        .catch((e) => console.warn("Theme save failed:", e.message));
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
