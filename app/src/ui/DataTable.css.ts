import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

const WIDE = "screen and (min-width: 640px)";

export const table = style({
  display: "block",
  width: "100%",
  "@media": { [WIDE]: { display: "table", borderCollapse: "collapse" } },
});

export const head = style({
  // Column headings are replaced by per-cell labels while rows are cards.
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clipPath: "inset(50%)",
  "@media": {
    [WIDE]: {
      position: "static",
      width: "auto",
      height: "auto",
      overflow: "visible",
      clipPath: "none",
      display: "table-header-group",
    },
  },
});

export const body = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  "@media": { [WIDE]: { display: "table-row-group" } },
});

export const row = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
  padding: vars.space["3"],
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  "@media": {
    [WIDE]: {
      display: "table-row",
      padding: 0,
      background: "transparent",
      border: 0,
      borderRadius: 0,
    },
  },
});

export const headRow = style({ display: "table-row" });

export const headerCell = style({
  textAlign: "start",
  padding: `${vars.space["2"]} ${vars.space["3"]}`,
  borderBottom: `2px solid ${vars.color.border}`,
  color: vars.color.textMuted,
  fontWeight: 600,
  fontSize: vars.fontSize.small,
  "@media": { [WIDE]: { display: "table-cell" } },
});

export const cell = style({
  display: "flex",
  justifyContent: "space-between",
  gap: vars.space["3"],
  minWidth: 0,
  overflowWrap: "anywhere",
  selectors: {
    "&::before": {
      content: "attr(data-label)",
      color: vars.color.textMuted,
      fontWeight: 600,
      flexShrink: 0,
    },
  },
  "@media": {
    [WIDE]: {
      display: "table-cell",
      padding: `${vars.space["3"]} ${vars.space["3"]}`,
      borderBottom: `1px solid ${vars.color.border}`,
      selectors: { "&::before": { content: "none" } },
    },
  },
});
