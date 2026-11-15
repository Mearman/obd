import { createSprinkles, defineProperties } from "@vanilla-extract/sprinkles";
import { vars } from "./contract.css";

/** Minimum viewport widths, in pixels, at which the tablet and desktop layouts begin. */
export const BREAKPOINTS = { tablet: 640, desktop: 1024 } as const;

const responsive = defineProperties({
  conditions: {
    phone: {},
    tablet: { "@media": `screen and (min-width: ${String(BREAKPOINTS.tablet)}px)` },
    desktop: { "@media": `screen and (min-width: ${String(BREAKPOINTS.desktop)}px)` },
  },
  defaultCondition: "phone",
  properties: {
    display: ["none", "block", "flex", "grid"],
    flexDirection: ["row", "column"],
    flexWrap: ["wrap", "nowrap"],
    alignItems: ["stretch", "flex-start", "center", "flex-end", "baseline"],
    justifyContent: ["flex-start", "center", "space-between", "flex-end"],
    gap: vars.space,
    paddingInline: vars.space,
    paddingBlock: vars.space,
    gridTemplateColumns: {
      one: "minmax(0, 1fr)",
      two: "repeat(2, minmax(0, 1fr))",
      three: "repeat(3, minmax(0, 1fr))",
    },
  },
  shorthands: { padding: ["paddingInline", "paddingBlock"] },
});

const text = defineProperties({
  properties: {
    fontSize: vars.fontSize,
    color: { text: vars.color.text, muted: vars.color.textMuted, danger: vars.color.danger },
    fontWeight: { normal: 400, medium: 500, bold: 700 },
    minWidth: { zero: 0 },
  },
});

/** Layout and text utilities with phone, tablet and desktop variants for the layout ones. */
export const sprinkles = createSprinkles(responsive, text);

/** The props {@link sprinkles} accepts. */
export type Sprinkles = Parameters<typeof sprinkles>[0];
