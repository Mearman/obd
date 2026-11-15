import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const field = style({ display: "flex", flexDirection: "column", gap: vars.space["1"] });

export const label = style({ fontWeight: 600 });

export const input = style({
  minHeight: vars.size.touch,
  width: "100%",
  paddingInline: vars.space["3"],
  background: vars.color.surface,
  color: vars.color.text,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  fontFamily: vars.fontFamily.mono,
  fontSize: vars.fontSize.body,
});
