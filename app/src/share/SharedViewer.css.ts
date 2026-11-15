import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const sparkline = style({
  width: "8rem",
  height: "1.75rem",
  stroke: vars.color.accent,
});
