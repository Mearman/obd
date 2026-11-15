import { style } from "@vanilla-extract/css";
import { vars } from "../theme/contract.css";

/** The current phase: the one thing on screen meant to be read from arm's length, so its type is large and plain. */
export const phaseCard = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["4"],
  padding: vars.space["5"],
  borderRadius: vars.radius.large,
  border: `2px solid ${vars.color.accent}`,
  background: vars.color.surfaceRaised,
  minWidth: 0,
});

export const phaseStep = style({
  margin: 0,
  fontSize: vars.fontSize.large,
  color: vars.color.textMuted,
});

export const phaseTitle = style({
  margin: 0,
  fontSize: vars.fontSize.display,
  lineHeight: vars.lineHeight.tight,
});

export const instruction = style({
  margin: 0,
  fontSize: "clamp(1.5rem, 5vw, 2.5rem)",
  lineHeight: 1.3,
  fontWeight: 600,
  overflowWrap: "anywhere",
});

/** The plan's own safety text, set apart so it is seen before anyone touches a pedal. */
export const safety = style({
  margin: 0,
  padding: vars.space["3"],
  borderRadius: vars.radius.medium,
  border: `2px solid ${vars.color.warning}`,
  background: vars.color.warningSubtle,
  fontSize: vars.fontSize.large,
  lineHeight: vars.lineHeight.normal,
});

export const waitText = style({ margin: 0, fontSize: vars.fontSize.large });

export const countdown = style({
  margin: 0,
  fontSize: "clamp(2rem, 10vw, 4rem)",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  lineHeight: 1,
});

export const meter = style({
  inlineSize: "100%",
  blockSize: vars.space["4"],
  accentColor: vars.color.accent,
});

export const readings = style({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
  gap: vars.space["3"],
  margin: 0,
});

export const reading = style({
  display: "flex",
  flexDirection: "column",
  gap: vars.space["1"],
  padding: vars.space["3"],
  borderRadius: vars.radius.medium,
  background: vars.color.surface,
  border: `1px solid ${vars.color.border}`,
  minWidth: 0,
});

export const readingValue = style({
  margin: 0,
  fontSize: vars.fontSize.title,
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
});

export const confirmButton = style({
  minHeight: "4rem",
  fontSize: vars.fontSize.large,
});

export const controls = style({
  display: "flex",
  flexWrap: "wrap",
  gap: vars.space["3"],
});

export const phaseList = style({
  margin: 0,
  paddingInlineStart: vars.space["5"],
  display: "flex",
  flexDirection: "column",
  gap: vars.space["3"],
});

export const visuallyHidden = style({
  position: "absolute",
  inlineSize: "1px",
  blockSize: "1px",
  margin: "-1px",
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
});
