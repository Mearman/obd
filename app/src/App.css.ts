import { style } from "@vanilla-extract/css";
import { vars } from "./theme/contract.css";

const TABLET = "screen and (min-width: 640px)";

export const app = style({
  minHeight: "100dvh",
  display: "flex",
  flexDirection: "column",
});

export const header = style({
  // Above the navigation on tablet and desktop, where the navigation is a row under it.
  order: -2,
  position: "sticky",
  top: 0,
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["3"],
  paddingBlock: vars.space["2"],
  paddingTop: `max(${vars.space["2"]}, env(safe-area-inset-top))`,
  paddingInline: `max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right))`,
  background: vars.color.surface,
  borderBottom: `1px solid ${vars.color.border}`,
});

export const brand = style({ fontSize: vars.fontSize.large, fontWeight: 700 });

export const status = style({ display: "flex", alignItems: "center", gap: vars.space["2"] });

export const main = style({
  flex: 1,
  width: "100%",
  maxWidth: vars.size.contentMax,
  marginInline: "auto",
  minWidth: 0,
  paddingBlock: vars.space["4"],
  paddingInline: `max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right))`,
  // Clear the fixed bottom navigation on a phone.
  paddingBottom: `calc(${vars.size.touch} + ${vars.space["6"]} + env(safe-area-inset-bottom))`,
  "@media": {
    [TABLET]: { paddingBlock: vars.space["5"], paddingBottom: vars.space["5"] },
  },
});

// Navigation sits at the bottom of a phone, in thumb reach, and moves to the top from tablet width.
export const nav = style({
  position: "fixed",
  insetInline: 0,
  bottom: 0,
  zIndex: 20,
  paddingBottom: "env(safe-area-inset-bottom)",
  paddingInline: "env(safe-area-inset-left) env(safe-area-inset-right)",
  "@media": {
    [TABLET]: {
      position: "static",
      order: -1,
      paddingBlock: 0,
      borderTop: 0,
      borderBottom: `1px solid ${vars.color.border}`,
    },
  },
});
