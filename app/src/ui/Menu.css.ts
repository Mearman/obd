import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const content = style({
  zIndex: 30,
  minWidth: "10rem",
  padding: vars.space["1"],
  background: vars.color.surfaceRaised,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  boxShadow: vars.shadow.raised,
});

export const item = style({
  display: "flex",
  alignItems: "center",
  minHeight: vars.size.touch,
  paddingInline: vars.space["3"],
  borderRadius: vars.radius.small,
  cursor: "pointer",
  outline: "none",
  selectors: { "&[data-highlighted]": { background: vars.color.accentSubtle } },
});
