import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const field = style({ display: "flex", flexDirection: "column", gap: vars.space["1"] });

export const fieldLabel = style({ fontWeight: 600 });

export const trigger = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["3"],
  width: "100%",
  minHeight: vars.size.touch,
  padding: `${vars.space["2"]} ${vars.space["3"]}`,
  textAlign: "left",
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  cursor: "pointer",
  selectors: { "&:disabled": { opacity: 0.55, cursor: "not-allowed" } },
});

export const stack = style({ display: "flex", flexDirection: "column", minWidth: 0 });
export const primary = style({ fontWeight: 600 });
export const secondary = style({ color: vars.color.textMuted, fontSize: vars.fontSize.small });

export const overlay = style({
  position: "fixed",
  inset: 0,
  background: vars.color.overlay,
  zIndex: 40,
});

export const panel = style({
  position: "fixed",
  zIndex: 41,
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(36rem, calc(100vw - 2 * 16px))",
  maxHeight: "calc(100dvh - 2 * 16px)",
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  padding: vars.space["4"],
  background: vars.color.surfaceRaised,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.large,
  boxShadow: vars.shadow.raised,
});

export const heading = style({ fontSize: vars.fontSize.title, lineHeight: vars.lineHeight.tight });

export const search = style({
  minHeight: vars.size.touch,
  paddingInline: vars.space["3"],
  background: vars.color.surface,
  color: vars.color.text,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  fontSize: vars.fontSize.body,
});

export const list = style({
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
  margin: 0,
  padding: 0,
  listStyle: "none",
});

export const groupLabel = style({
  position: "sticky",
  top: 0,
  padding: `${vars.space["2"]} ${vars.space["3"]}`,
  background: vars.color.surfaceRaised,
  color: vars.color.textMuted,
  fontSize: vars.fontSize.small,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
});

export const option = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["3"],
  width: "100%",
  minHeight: vars.size.touch,
  padding: `${vars.space["2"]} ${vars.space["3"]}`,
  textAlign: "left",
  background: "transparent",
  border: "none",
  borderRadius: vars.radius.medium,
  cursor: "pointer",
  selectors: {
    "&:hover, &:focus-visible": { background: vars.color.accentSubtle },
    '&[aria-selected="true"]': { background: vars.color.accentSubtle, fontWeight: 700 },
  },
});

export const badges = style({
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["1"],
  marginBlockStart: vars.space["1"],
});

export const empty = style({ color: vars.color.textMuted, padding: vars.space["3"] });
