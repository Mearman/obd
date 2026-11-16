import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

/** A row's select checkbox, as large as any other touch target. */
export const selectBox = style({
  width: vars.size.touch,
  height: vars.size.touch,
  margin: 0,
  flex: "none",
});
