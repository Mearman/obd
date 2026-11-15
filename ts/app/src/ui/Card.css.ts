import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const card = style({
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.large,
  padding: vars.space["4"],
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  minWidth: 0,
});

export const cardTitle = style({
  fontSize: vars.fontSize.large,
  fontWeight: 700,
  lineHeight: vars.lineHeight.tight,
});

export const cardDescription = style({ color: vars.color.textMuted });
