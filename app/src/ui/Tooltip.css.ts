import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const content = style({
  zIndex: 50,
  maxWidth: "min(20rem, calc(100vw - 32px))",
  padding: `${vars.space["2"]} ${vars.space["3"]}`,
  background: vars.color.text,
  color: vars.color.background,
  borderRadius: vars.radius.small,
  fontSize: vars.fontSize.small,
});
