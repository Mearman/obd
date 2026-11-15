import { globalStyle, style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

// Matches WIDE_QUERY in useWideLayout.ts, from which several sections show at once.
const WIDE = "screen and (min-width: 1024px)";

// The shell's tablet width, from which the connection summary fits on one line beside Disconnect.
const TABLET = "screen and (min-width: 640px)";

/** Sticks under the shell's header, whose height `useHeaderOffset` sets as `top`. */
export const bar = style({
  position: "sticky",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  gap: vars.space["2"],
  padding: vars.space["2"],
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.large,
  boxShadow: vars.shadow.raised,
  minWidth: 0,
});

export const summary = style({
  display: "flex",
  alignItems: "center",
  gap: vars.space["2"],
  minWidth: 0,
  minHeight: vars.size.touch,
});

/** One line, cut off with an ellipsis where it does not fit beside Disconnect; the Connection section shows each part in full. */
export const summaryText = style({
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: vars.fontSize.small,
  "@media": { [TABLET]: { fontSize: vars.fontSize.body } },
});

export const summaryPart = style({
  selectors: { "& + &::before": { content: '" · "', color: vars.color.textMuted } },
});

/** One row; on the narrowest phones it scrolls sideways within itself rather than wrapping, so the bar stays two rows high. */
export const nav = style({
  display: "flex",
  gap: vars.space["1"],
  overflowX: "auto",
});

export const navButton = style({
  flex: "1 0 auto",
  minHeight: vars.size.touch,
  paddingInline: vars.space["2"],
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  background: vars.color.surface,
  color: vars.color.text,
  font: "inherit",
  fontSize: vars.fontSize.small,
  fontWeight: 600,
  "@media": { [TABLET]: { fontSize: vars.fontSize.body } },
  cursor: "pointer",
  selectors: {
    "&:hover": { background: vars.color.accentSubtle },
    '&[aria-expanded="true"]': {
      background: vars.color.accent,
      borderColor: vars.color.accent,
      color: vars.color.accentText,
    },
  },
});

export const sections = style({
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr)",
  gap: vars.space["4"],
  alignItems: "start",
  "@media": { [WIDE]: { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } },
});

export const section = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  minWidth: 0,
  // The display above would otherwise override the hidden attribute's own display: none.
  selectors: { "&[hidden]": { display: "none" } },
});

/** Connection and Advanced take the full width; Read and Live sit side by side on a wide screen. */
export const fullWidth = style({ "@media": { [WIDE]: { gridColumn: "1 / -1" } } });

export const sectionTitle = style({
  fontSize: vars.fontSize.title,
  lineHeight: vars.lineHeight.tight,
});

export const connectFirst = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: vars.space["2"],
  padding: vars.space["3"],
  borderRadius: vars.radius.medium,
  background: vars.color.warningSubtle,
  border: `1px solid ${vars.color.warning}`,
});

export const details = style({
  display: "grid",
  gridTemplateColumns: "max-content minmax(0, 1fr)",
  gap: `${vars.space["1"]} ${vars.space["3"]}`,
  margin: 0,
  overflowWrap: "anywhere",
});

globalStyle(`${details} dt`, { color: vars.color.textMuted });
globalStyle(`${details} dd`, { margin: 0 });
