import React, { createContext, useContext, useState } from "react";

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
  const [isDark, setIsDark] = useState(false);
  const theme = isDark ? dark : light;
  const toggleTheme = () => setIsDark((prev) => !prev);

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}