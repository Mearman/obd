import { style } from "@vanilla-extract/css";
import { vars } from "../../theme/contract.css";

export const presets = style({ display: "flex", flexWrap: "wrap", gap: vars.space["2"] });

export const group = style({
  margin: 0,
  padding: 0,
  border: 0,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
});

export const groupTitle = style({
  padding: 0,
  fontWeight: 600,
  fontSize: vars.fontSize.body,
});

export const checks = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: vars.space["1"],
  "@media": {
    "screen and (min-width: 640px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
    "screen and (min-width: 1024px)": { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
  },
});

// A button with the checkbox role, so the whole row is a 44 px target.
export const check = style({
  display: "flex",
  alignItems: "center",
  gap: vars.space["3"],
  minHeight: vars.size.touch,
  paddingInline: vars.space["2"],
  background: "transparent",
  color: vars.color.text,
  border: 0,
  borderRadius: vars.radius.medium,
  textAlign: "start",
  cursor: "pointer",
  selectors: {
    "&:hover:not(:disabled)": { background: vars.color.accentSubtle },
    "&:disabled": { opacity: 0.55, cursor: "not-allowed" },
  },
});

export const box = style({
  position: "relative",
  flexShrink: 0,
  width: "20px",
  height: "20px",
  borderRadius: vars.radius.small,
  border: `2px solid ${vars.color.textMuted}`,
  selectors: {
    '[aria-checked="true"] > &': { background: vars.color.accent, borderColor: vars.color.accent },
    '[aria-checked="true"] > &::after': {
      content: '""',
      position: "absolute",
      left: "5px",
      top: "1px",
      width: "5px",
      height: "10px",
      border: `solid ${vars.color.accentText}`,
      borderWidth: "0 2px 2px 0",
      transform: "rotate(45deg)",
    },
  },
});

export const checkText = style({ minWidth: 0, overflowWrap: "anywhere" });

export const estimate = style({ margin: 0, color: vars.color.textMuted });

export const groupHeading = style({
  margin: 0,
  fontSize: vars.fontSize.large,
  lineHeight: vars.lineHeight.tight,
});

export const groups = style({ display: "flex", flexDirection: "column", gap: vars.space["4"] });

export const note = style({
  display: "block",
  color: vars.color.warning,
  fontSize: vars.fontSize.small,
});
