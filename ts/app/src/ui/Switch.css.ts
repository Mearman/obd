import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const field = style({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["4"],
  minHeight: vars.size.touch,
});

export const label = style({ flex: 1, minWidth: 0 });

// The hit area is 44 px high; the visible track is smaller.
export const root = style({
  position: "relative",
  flexShrink: 0,
  width: "52px",
  height: vars.size.touch,
  padding: 0,
  background: "transparent",
  border: 0,
  cursor: "pointer",
  "::before": {
    content: '""',
    position: "absolute",
    inset: "8px 0",
    borderRadius: vars.radius.round,
    background: vars.color.border,
  },
  selectors: {
    '&[data-state="checked"]::before': { background: vars.color.accent },
  },
});

export const thumb = style({
  display: "block",
  position: "relative",
  width: "20px",
  height: "20px",
  borderRadius: vars.radius.round,
  background: vars.color.surface,
  border: `1px solid ${vars.color.textMuted}`,
  transform: "translateX(6px)",
  transition: "transform 120ms",
  selectors: { '&[data-state="checked"]': { transform: "translateX(26px)" } },
  "@media": { "(prefers-reduced-motion: reduce)": { transition: "none" } },
});
