import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const page = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["4"],
  minWidth: 0,
});

export const heading = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: vars.space["2"],
});

export const title = style({ fontSize: vars.fontSize.display, lineHeight: vars.lineHeight.tight });

export const muted = style({ color: vars.color.textMuted });

export const stack = style({ display: "flex", flexDirection: "column", gap: vars.space["3"] });

export const error = style({
  padding: vars.space["3"],
  borderRadius: vars.radius.medium,
  background: vars.color.dangerSubtle,
  color: vars.color.danger,
  border: `1px solid ${vars.color.danger}`,
});

export const list = style({ margin: 0, paddingInlineStart: vars.space["5"] });

export const optionGrid = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: vars.space["3"],
  "@media": {
    "screen and (min-width: 1024px)": { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
  },
});
