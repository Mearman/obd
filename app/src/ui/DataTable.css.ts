import { globalStyle, style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

/** The widths from which a table is a table rather than a card per row. */
export const BREAKPOINTS = { standard: "640px", roomy: "1100px" } as const;

/** The table's styles for the width `min` from which it stops being cards. */
function build(min: string) {
  const WIDE = `screen and (min-width: ${min})`;

  const table = style({
    display: "block",
    width: "100%",
    "@media": { [WIDE]: { display: "table", borderCollapse: "collapse" } },
  });

  const head = style({
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

  const body = style({
    display: "flex",
    flexDirection: "column",
    gap: vars.space["3"],
    "@media": { [WIDE]: { display: "table-row-group" } },
  });

  const row = style({
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

  const openable = style({
    cursor: "pointer",
    selectors: {
      "&:hover": { background: vars.color.border },
      "&:focus-visible": { outline: `2px solid ${vars.color.border}`, outlineOffset: "-2px" },
    },
  });

  /** A cell whose value stays on one line once the table is wide enough that every column can afford it. */
  const nowrapCell = style({
    "@media": { "screen and (min-width: 1100px)": { whiteSpace: "nowrap" } },
  });

  const headRow = style({ display: "table-row" });

  const headerCell = style({
    textAlign: "start",
    padding: `${vars.space["2"]} ${vars.space["3"]}`,
    borderBottom: `2px solid ${vars.color.border}`,
    color: vars.color.textMuted,
    fontWeight: 600,
    fontSize: vars.fontSize.small,
    "@media": { [WIDE]: { display: "table-cell" } },
  });

  const cell = style({
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
      // A value-less cell on a card is a label with nothing beside it.
      "&:has(> span:empty)": { display: "none" },
    },
    "@media": {
      [WIDE]: {
        display: "table-cell",
        verticalAlign: "middle",
        // Table columns size to their words; "anywhere" would let a column shrink until a word breaks mid-way.
        overflowWrap: "normal",
        padding: `${vars.space["3"]} ${vars.space["3"]}`,
        borderBottom: `1px solid ${vars.color.border}`,
        selectors: {
          "&::before": { content: "none" },
          "&:has(> span:empty)": { display: "table-cell" },
        },
      },
    },
  });

  /** A cell with no heading of its own on a phone's card, such as a row's select checkbox. */
  const bareCell = style({
    selectors: { "&::before": { content: "none" } },
  });

  /** The head of a sortable table, which stays on a phone as a row of sort buttons above the cards. */
  const sortableHead = style({
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

  const sortableHeaderCell = style({
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

  const sortButton = style({
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

  const group = style({
    display: "flex",
    flexDirection: "column",
    gap: vars.space["2"],
  });

  const groupHeading = style({ margin: 0, fontSize: vars.fontSize.body });

  const groupToggle = style({
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

  return {
    table,
    head,
    body,
    row,
    openable,
    nowrapCell,
    headRow,
    headerCell,
    cell,
    bareCell,
    sortableHead,
    sortableHeaderCell,
    sortButton,
    group,
    groupHeading,
    groupToggle,
  };
}

export const tableStyles = {
  standard: build(BREAKPOINTS.standard),
  roomy: build(BREAKPOINTS.roomy),
};
