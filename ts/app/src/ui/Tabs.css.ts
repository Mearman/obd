import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const root = style({ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 });

export const list = style({
  display: "flex",
  gap: vars.space["1"],
  background: vars.color.surface,
  borderTop: `1px solid ${vars.color.border}`,
});

export const trigger = style({
  flex: 1,
  minHeight: vars.size.touch,
  minWidth: vars.size.touch,
  paddingInline: vars.space["1"],
  background: "transparent",
  border: 0,
  borderTop: "3px solid transparent",
  color: vars.color.textMuted,
  fontWeight: 600,
  cursor: "pointer",
  selectors: {
    '&[data-state="active"]': { color: vars.color.accent, borderTopColor: vars.color.accent },
    "&:hover": { background: vars.color.accentSubtle },
  },
});

export const content = style({ flex: 1, minWidth: 0 });
