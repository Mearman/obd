import { globalStyle, style } from "@vanilla-extract/css";
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

export const openable = style({
  cursor: "pointer",
  selectors: {
    "&:hover": { background: vars.color.border },
    "&:focus-visible": { outline: `2px solid ${vars.color.border}`, outlineOffset: "-2px" },
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

/** The head of a sortable table, which stays on a phone as a row of sort buttons above the cards. */
export const sortableHead = style({
  display: "block",
  marginBottom: vars.space["3"],
  "@media": { [WIDE]: { display: "table-header-group", marginBottom: 0 } },
});

globalStyle(`${sortableHead} > [role=row]`, {
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["2"],
  "@media": { [WIDE]: { display: "table-row" } },
});

export const sortableHeaderCell = style({
  padding: 0,
  borderBottom: 0,
  "@media": {
    [WIDE]: {
      padding: `${vars.space["1"]} ${vars.space["1"]}`,
      borderBottom: `2px solid ${vars.color.border}`,
    },
  },
});

// A heading that cannot be sorted by has nothing to do on a phone, where each card labels its own values.
globalStyle(`${sortableHead} [role=columnheader]:not(${sortableHeaderCell})`, {
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
    },
  },
});

export const sortButton = style({
  display: "inline-flex",
  alignItems: "center",
  gap: vars.space["1"],
  minHeight: vars.size.touch,
  minWidth: vars.size.touch,
  paddingInline: vars.space["2"],
  background: "transparent",
  color: "inherit",
  font: "inherit",
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  cursor: "pointer",
  selectors: {
    "&:hover": { background: vars.color.border },
  },
  "@media": { [WIDE]: { borderColor: "transparent" } },
});

export const group = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["2"],
});

export const groupHeading = style({ margin: 0, fontSize: vars.fontSize.body });

export const groupToggle = style({
  display: "inline-flex",
  alignItems: "center",
  gap: vars.space["2"],
  minHeight: vars.size.touch,
  paddingInline: vars.space["2"],
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontWeight: 600,
  border: 0,
  borderRadius: vars.radius.medium,
  cursor: "pointer",
  selectors: {
    "&:hover": { background: vars.color.border },
  },
});
