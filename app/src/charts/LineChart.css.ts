import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const chart = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
  minWidth: 0,
  margin: 0,
  padding: vars.space["3"],
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
});

export const caption = style({
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  alignItems: "baseline",
  columnGap: vars.space["3"],
  minWidth: 0,
  fontSize: vars.fontSize.small,
});

export const captionName = style({ fontWeight: 600, overflowWrap: "anywhere" });

export const reading = style({
  fontFamily: vars.fontFamily.mono,
  color: vars.color.text,
  fontVariantNumeric: "tabular-nums",
});

export const body = style({
  display: "grid",
  gridTemplateColumns: "minmax(2.5rem, auto) minmax(0, 1fr)",
  columnGap: vars.space["2"],
  minWidth: 0,
});

export const yAxis = style({
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  alignItems: "flex-end",
  fontFamily: vars.fontFamily.mono,
  fontSize: vars.fontSize.small,
  color: vars.color.textMuted,
  fontVariantNumeric: "tabular-nums",
});

export const plotWrap = style({
  position: "relative",
  height: "7rem",
  minWidth: 0,
  borderLeft: `1px solid ${vars.color.border}`,
  borderBottom: `1px solid ${vars.color.border}`,
});

export const plot = style({ position: "absolute", inset: 0 });

export const svg = style({
  display: "block",
  width: "100%",
  height: "100%",
  overflow: "visible",
});

export const grid = style({
  stroke: vars.color.border,
  strokeWidth: 1,
  strokeDasharray: "4 4",
});

export const line = style({
  fill: "none",
  stroke: vars.color.accent,
  strokeWidth: 2,
  strokeLinejoin: "round",
  strokeLinecap: "round",
});

export const cursorLine = style({
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 0,
  borderLeft: `2px dashed ${vars.color.text}`,
  pointerEvents: "none",
});

export const cursorDot = style({
  position: "absolute",
  width: "0.75rem",
  height: "0.75rem",
  marginLeft: "-0.375rem",
  marginTop: "-0.375rem",
  boxSizing: "border-box",
  background: vars.color.surface,
  border: `3px solid ${vars.color.text}`,
  borderRadius: vars.radius.round,
  pointerEvents: "none",
});

export const slider = style({
  position: "absolute",
  inset: 0,
  touchAction: "pan-y",
  cursor: "crosshair",
  borderRadius: vars.radius.small,
  selectors: {
    "&:focus-visible": { outline: `3px solid ${vars.color.focusRing}`, outlineOffset: "2px" },
  },
});

export const xAxis = style({
  display: "flex",
  justifyContent: "space-between",
  gap: vars.space["2"],
  gridColumn: 2,
  marginTop: vars.space["1"],
  fontFamily: vars.fontFamily.mono,
  fontSize: vars.fontSize.small,
  color: vars.color.textMuted,
  fontVariantNumeric: "tabular-nums",
});

export const compact = style({
  display: "block",
  width: "8rem",
  maxWidth: "100%",
  height: "1.75rem",
});

export const compactSvg = style({ display: "block", width: "100%", height: "100%" });
