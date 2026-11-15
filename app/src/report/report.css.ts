import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const fallback = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  padding: vars.space["4"],
  borderRadius: vars.radius.large,
  border: `1px solid ${vars.color.danger}`,
  background: vars.color.dangerSubtle,
  color: vars.color.text,
});

export const fallbackTitle = style({
  fontSize: vars.fontSize.title,
  lineHeight: vars.lineHeight.tight,
});

export const root = style({
  maxWidth: vars.size.contentMax,
  marginInline: "auto",
  padding: vars.space["4"],
  minHeight: "100dvh",
  background: vars.color.background,
  color: vars.color.text,
});

export const buttons = style({
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["2"],
});

export const reportText = style({
  margin: 0,
  padding: vars.space["3"],
  maxHeight: "40dvh",
  overflow: "auto",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  background: vars.color.background,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  fontFamily: vars.fontFamily.mono,
  fontSize: vars.fontSize.small,
});

export const note = style({ color: vars.color.textMuted, margin: 0 });
