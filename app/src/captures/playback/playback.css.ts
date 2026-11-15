import { style } from "@vanilla-extract/css";
import { vars } from "../../theme/contract.css";

export const panel = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  minWidth: 0,
  padding: vars.space["3"],
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  background: vars.color.surface,
});

export const strip = style({
  position: "relative",
  display: "flex",
  height: 28,
  minWidth: 0,
  overflow: "hidden",
  borderRadius: vars.radius.small,
  border: `1px solid ${vars.color.border}`,
  background: vars.color.background,
  cursor: "pointer",
});

export const cell = style({
  flex: "1 1 0",
  minWidth: 0,
  borderInlineEnd: `1px solid ${vars.color.background}`,
});

export const cellAnswered = style({ background: vars.color.successSubtle });
export const cellNegative = style({ background: vars.color.warning });
export const cellUnanswered = style({ background: vars.color.danger });

/** The cells before the cursor are drawn at full strength and the rest dimmed, so the cursor reads without colour. */
export const cellFuture = style({ opacity: 0.35 });

export const cursor = style({
  position: "absolute",
  top: 0,
  bottom: 0,
  width: 3,
  background: vars.color.text,
  pointerEvents: "none",
});

export const marks = style({
  position: "relative",
  height: 16,
  minWidth: 0,
  overflow: "hidden",
  fontSize: vars.fontSize.small,
  lineHeight: 1,
  pointerEvents: "none",
});

export const mark = style({
  position: "absolute",
  top: 0,
  transform: "translateX(-50%)",
});

export const markNegative = style({ color: vars.color.warning });
export const markUnanswered = style({ color: vars.color.danger });

export const controls = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: vars.space["2"],
  minWidth: 0,
});

export const speeds = style({
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["1"],
  margin: 0,
  padding: 0,
  border: 0,
  minWidth: 0,
});

export const scrubber = style({
  width: "100%",
  minHeight: vars.size.touch,
  margin: 0,
  accentColor: vars.color.accent,
  cursor: "pointer",
});

export const legend = style({
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["3"],
  margin: 0,
  padding: 0,
  listStyle: "none",
  color: vars.color.textMuted,
  fontSize: vars.fontSize.small,
});

export const now = style({ margin: 0, overflowWrap: "anywhere" });

export const windowScroll = style({
  position: "relative",
  overflowY: "auto",
  overflowX: "hidden",
  minWidth: 0,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.small,
  background: vars.color.background,
  ":focus-visible": { outline: `2px solid ${vars.color.focusRing}`, outlineOffset: 2 },
});

export const windowInner = style({ position: "relative", minWidth: 0 });

export const rowItem = style({
  position: "absolute",
  insetInline: 0,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: vars.space["1"],
  minWidth: 0,
  boxSizing: "border-box",
  paddingInline: vars.space["3"],
  borderBottom: `1px solid ${vars.color.border}`,
  overflow: "hidden",
});

export const rowHead = style({
  display: "flex",
  alignItems: "center",
  gap: vars.space["2"],
  minWidth: 0,
});

export const rowText = style({
  flex: "1 1 0",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: vars.color.textMuted,
});

export const rowBody = style({
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: vars.fontFamily.mono,
  fontSize: vars.fontSize.small,
});

export const busy = style({ opacity: 0.6 });

export const visuallyHidden = style({
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
});
