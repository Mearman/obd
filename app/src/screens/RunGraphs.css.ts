import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const controls = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
});

export const transport = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: vars.space["3"],
});

export const speeds = style({
  display: "flex",
  alignItems: "center",
  gap: vars.space["1"],
});

export const clock = style({
  fontFamily: vars.fontFamily.mono,
  fontVariantNumeric: "tabular-nums",
  marginInlineStart: "auto",
});

export const scrubber = style({
  width: "100%",
  minHeight: vars.size.touch,
  margin: 0,
  accentColor: vars.color.accent,
  selectors: {
    "&:focus-visible": { outline: `3px solid ${vars.color.focusRing}`, outlineOffset: "2px" },
  },
});

export const charts = style({
  display: "grid",
  // One chart fills the width; several share it, each at least as wide as a phone can show.
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 26rem), 1fr))",
  gap: vars.space["3"],
});
