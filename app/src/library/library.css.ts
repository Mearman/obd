import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

/** The row's select control: a touch-sized hit area around a checkbox drawn at a normal size, so the tick does not dominate the row. */
export const selectLabel = style({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: vars.size.touch,
  height: vars.size.touch,
  cursor: "pointer",
});

export const selectBox = style({
  width: "1.25rem",
  height: "1.25rem",
  margin: 0,
  flex: "none",
  accentColor: vars.color.accent,
});
