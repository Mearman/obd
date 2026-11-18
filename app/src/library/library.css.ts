import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

/**
 * A row's select checkbox: the control keeps the full touch-sized hit area, and the visible box is drawn smaller inside it so the tick does not dominate the row.
 */
export const selectBox = style({
  appearance: "none",
  display: "inline-grid",
  placeItems: "center",
  width: vars.size.touch,
  height: vars.size.touch,
  margin: 0,
  flex: "none",
  cursor: "pointer",
  background: "transparent",
  selectors: {
    "&::before": {
      content: '""',
      width: "1.25rem",
      height: "1.25rem",
      boxSizing: "border-box",
      border: `2px solid ${vars.color.textMuted}`,
      borderRadius: vars.radius.small,
      background: vars.color.surface,
    },
    "&:checked::before": {
      borderColor: vars.color.accent,
      background: `${vars.color.accent} center / 80% no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8.5l3.2 3L13 4.5' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
    },
    "&:focus-visible": { outline: `2px solid ${vars.color.accent}`, outlineOffset: "-2px" },
  },
});

/** A run's actions: wrapping on a phone or tablet, one line once the Library has the width. */
export const actionsRow = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: vars.space["2"],
  "@media": { "screen and (min-width: 1100px)": { flexWrap: "nowrap" } },
});

/** A row's vehicle: the VIN, with the short name a profile gives it on a line of its own below; a VIN breaks anywhere rather than push the narrowest phone sideways. */
export const vehicleCell = style({
  display: "flex",
  flexDirection: "column",
  overflowWrap: "anywhere",
});
