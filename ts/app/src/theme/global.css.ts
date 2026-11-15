import { globalStyle } from "@vanilla-extract/css";
import { vars } from "./contract.css";

globalStyle("*, *::before, *::after", { boxSizing: "border-box" });

globalStyle("html", { WebkitTextSizeAdjust: "100%", textSizeAdjust: "100%" });

// The body background is explicit so a page never shows the browser default behind the app.
globalStyle("body", {
  margin: 0,
  minHeight: "100dvh",
  background: vars.color.background,
  color: vars.color.text,
  fontFamily: vars.fontFamily.body,
  fontSize: vars.fontSize.body,
  lineHeight: vars.lineHeight.normal,
  overflowX: "hidden",
});

globalStyle("h1, h2, h3, p", { margin: 0 });
globalStyle("button, input, select, textarea", { font: "inherit", color: "inherit" });
globalStyle("code", { fontFamily: vars.fontFamily.mono, fontSize: "0.9em" });

globalStyle(":focus-visible", {
  outline: `3px solid ${vars.color.focusRing}`,
  outlineOffset: "2px",
});
