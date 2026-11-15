import { assignVars, createGlobalTheme, globalStyle } from "@vanilla-extract/css";
import { vars } from "./contract.css";

type Colours = Record<keyof typeof vars.color, string>;

createGlobalTheme(":root", vars, {
  color: {
    background: "#f5f7f9",
    surface: "#ffffff",
    surfaceRaised: "#ffffff",
    border: "#c9d3dc",
    text: "#14212b",
    textMuted: "#4a5b69",
    accent: "#0b5f94",
    accentHover: "#084a74",
    accentText: "#ffffff",
    accentSubtle: "#e1eef7",
    success: "#1b6e3c",
    successSubtle: "#e0f2e7",
    warning: "#8a5a00",
    warningSubtle: "#fdf0d2",
    danger: "#b3261e",
    dangerSubtle: "#fbe3e1",
    simulated: "#6b3fa0",
    simulatedSubtle: "#efe6f8",
    focusRing: "#0b5f94",
    overlay: "rgb(10 20 30 / 0.5)",
  },
  space: {
    "1": "4px",
    "2": "8px",
    "3": "12px",
    "4": "16px",
    "5": "24px",
    "6": "32px",
    "8": "48px",
  },
  fontSize: {
    small: "0.875rem",
    body: "1rem",
    large: "1.125rem",
    title: "1.375rem",
    display: "1.75rem",
  },
  lineHeight: { tight: "1.25", normal: "1.5" },
  radius: { small: "6px", medium: "10px", large: "16px", round: "999px" },
  size: { touch: "44px", contentMax: "72rem" },
  fontFamily: {
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  },
  shadow: { raised: "0 1px 2px rgb(10 20 30 / 0.12), 0 4px 12px rgb(10 20 30 / 0.08)" },
});

const dark: Colours = {
  background: "#0e1419",
  surface: "#161e25",
  surfaceRaised: "#1e2830",
  border: "#33424e",
  text: "#e6edf2",
  textMuted: "#a3b3c0",
  accent: "#6cb8ea",
  accentHover: "#93cbf0",
  accentText: "#06222f",
  accentSubtle: "#16303f",
  success: "#6fd195",
  successSubtle: "#143321",
  warning: "#f0c15a",
  warningSubtle: "#3a2c0b",
  danger: "#ff8f87",
  dangerSubtle: "#40181a",
  simulated: "#c9a6f0",
  simulatedSubtle: "#2c1d40",
  focusRing: "#93cbf0",
  overlay: "rgb(0 0 0 / 0.65)",
};

// Follow the system unless the user chose a theme: the manual choice sets `data-theme` on <html>.
globalStyle(":root", { colorScheme: "light dark" });
globalStyle(':root[data-theme="light"]', { colorScheme: "light" });
globalStyle(':root[data-theme="dark"]', {
  colorScheme: "dark",
  vars: assignVars(vars.color, dark),
});
globalStyle(':root:not([data-theme="light"])', {
  "@media": { "(prefers-color-scheme: dark)": { vars: assignVars(vars.color, dark) } },
});
