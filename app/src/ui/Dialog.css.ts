import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const overlay = style({
  position: "fixed",
  inset: 0,
  background: vars.color.overlay,
  zIndex: 40,
});

export const content = style({
  position: "fixed",
  zIndex: 41,
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(32rem, calc(100vw - 2 * 16px))",
  maxHeight: "calc(100dvh - 2 * 16px)",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  padding: vars.space["5"],
  background: vars.color.surfaceRaised,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.large,
  boxShadow: vars.shadow.raised,
});

export const title = style({ fontSize: vars.fontSize.title, lineHeight: vars.lineHeight.tight });

export const description = style({ color: vars.color.textMuted });

export const actions = style({ display: "flex", justifyContent: "flex-end", gap: vars.space["2"] });
