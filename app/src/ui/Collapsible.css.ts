import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const collapsible = style({
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.large,
  minWidth: 0,
});

export const heading = style({
  margin: 0,
  fontSize: vars.fontSize.large,
  lineHeight: vars.lineHeight.tight,
});

export const trigger = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["2"],
  width: "100%",
  minHeight: vars.size.touch,
  padding: vars.space["4"],
  border: 0,
  borderRadius: vars.radius.large,
  background: "transparent",
  color: vars.color.text,
  font: "inherit",
  fontWeight: 700,
  textAlign: "start",
  cursor: "pointer",
  selectors: { "&:hover": { background: vars.color.accentSubtle } },
});

export const chevron = style({
  flexShrink: 0,
  transition: "transform 150ms ease",
  selectors: { '[aria-expanded="true"] > &': { transform: "rotate(180deg)" } },
});

export const body = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  padding: vars.space["4"],
  paddingTop: 0,
  minWidth: 0,
  // The display above would otherwise override the hidden attribute's own display: none.
  selectors: { "&[hidden]": { display: "none" } },
});
