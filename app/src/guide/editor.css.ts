import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

/** A group of related fields, such as one phase or one wait, set apart with a border. */
export const group = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
  minWidth: 0,
  margin: 0,
  padding: vars.space["3"],
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
});

export const legend = style({ fontWeight: 600, paddingInline: vars.space["1"] });

/** Fields side by side where there is room, stacked on a phone. */
export const fields = style({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))",
  gap: vars.space["3"],
  minWidth: 0,
});

/** A native select or textarea styled like the text fields, with a 44 px target. */
export const control = style({
  minHeight: vars.size.touch,
  width: "100%",
  minWidth: 0,
  paddingInline: vars.space["3"],
  background: vars.color.surface,
  color: vars.color.text,
  border: `1px solid ${vars.color.border}`,
  borderRadius: vars.radius.medium,
  fontSize: vars.fontSize.body,
});

export const textarea = style([
  control,
  {
    minHeight: "16rem",
    padding: vars.space["3"],
    fontFamily: vars.fontFamily.mono,
    fontSize: vars.fontSize.small,
    resize: "vertical",
  },
]);

/** A checkbox with its label, the whole row a 44 px target. */
export const check = style({
  display: "flex",
  alignItems: "center",
  gap: vars.space["2"],
  minHeight: vars.size.touch,
  minWidth: 0,
  overflowWrap: "anywhere",
  cursor: "pointer",
});

export const checkBox = style({ width: "1.25rem", height: "1.25rem", flex: "none" });

/** The checklist of value names: as many columns as fit. */
export const checklist = style({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 13rem), 1fr))",
  columnGap: vars.space["3"],
  margin: 0,
  padding: 0,
  listStyle: "none",
});

/** Buttons in a row that wrap on a narrow screen. */
export const actions = style({
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["2"],
});

/** Problems shown beside the fields they are about. */
export const problems = style({
  margin: 0,
  paddingInlineStart: vars.space["5"],
  color: vars.color.danger,
  overflowWrap: "anywhere",
});

export const fieldLabel = style({ fontWeight: 600 });

export const fieldStack = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
  minWidth: 0,
});

/** One stored plan in the list. */
export const planRow = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["2"],
  paddingBlock: vars.space["3"],
  borderBottom: `1px solid ${vars.color.border}`,
  minWidth: 0,
  overflowWrap: "anywhere",
});

export const planList = style({ margin: 0, padding: 0, listStyle: "none" });

/** The checklist inside its disclosure, which already draws the border. */
export const bareFieldset = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
  minWidth: 0,
  margin: 0,
  padding: 0,
  border: 0,
});
