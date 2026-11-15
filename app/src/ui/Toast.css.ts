import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

export const viewport = style({
  position: "fixed",
  zIndex: 60,
  insetInline: 0,
  bottom: "calc(env(safe-area-inset-bottom) + 72px)",
  margin: 0,
  padding: `0 max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left))`,
  display: "flex",
  flexDirection: "column",
  gap: vars.space["2"],
  listStyle: "none",
  outline: "none",
  "@media": {
    "screen and (min-width: 1024px)": {
      insetInlineStart: "auto",
      width: "24rem",
      bottom: vars.space["4"],
    },
  },
});

export const root = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["2"],
  padding: vars.space["4"],
  background: vars.color.surfaceRaised,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  boxShadow: vars.shadow.raised,
});

export const title = style({ fontWeight: 700 });
export const description = style({ color: vars.color.textMuted });
export const actions = style({ display: "flex", gap: vars.space["2"], flexWrap: "wrap" });
