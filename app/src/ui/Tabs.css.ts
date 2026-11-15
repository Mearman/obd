import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const root = style({ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 });

// Below this width the labels are set smaller, with no gap between tabs, so every tab fits a phone's width.
const WIDE = "screen and (min-width: 640px)";

export const list = style({
  display: "flex",
  gap: 0,
  "@media": { [WIDE]: { gap: vars.space["1"] } },
  background: vars.color.surface,
  borderTop: `1px solid ${vars.color.border}`,
  // A phone narrower than the labels scrolls the bar rather than letting labels overlap.
  overflowX: "auto",
  scrollbarWidth: "none",
});

export const trigger = style({
  flex: "1 0 auto",
  minHeight: vars.size.touch,
  minWidth: vars.size.touch,
  paddingInline: vars.space["1"],
  // A phone tab bar's label size: every label must fit beside the others at a phone's width, with the wider system fonts of some platforms.
  fontSize: "0.75rem",
  "@media": { [WIDE]: { fontSize: vars.fontSize.body } },
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
