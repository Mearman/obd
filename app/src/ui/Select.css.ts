import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const field = style({ display: "flex", flexDirection: "column", gap: vars.space["1"] });

export const label = style({ fontWeight: 600 });

export const trigger = style({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["2"],
  minHeight: vars.size.touch,
  width: "100%",
  paddingInline: vars.space["3"],
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  cursor: "pointer",
  selectors: { "&:disabled": { opacity: 0.55, cursor: "not-allowed" } },
});

// Above the dialog's overlay and content (40 and 41): a select inside a dialog opens its list over it, and a list beneath the overlay cannot be clicked.
export const content = style({
  zIndex: 45,
  minWidth: "var(--radix-select-trigger-width)",
  maxHeight: "var(--radix-select-content-available-height)",
  overflow: "hidden",
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
  cursor: "pointer",
  outline: "none",
  selectors: {
    "&[data-highlighted]": { background: vars.color.accentSubtle },
    '&[data-state="checked"]': { fontWeight: 700 },
  },
});
