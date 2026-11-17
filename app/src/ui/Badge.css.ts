import { recipe } from "@vanilla-extract/recipes";
import { vars } from "../theme/contract.css";

export const badge = recipe({
  base: {
    display: "inline-flex",
    alignItems: "center",
    paddingInline: vars.space["2"],
    paddingBlock: "2px",
    borderRadius: vars.radius.round,
    fontSize: vars.fontSize.small,
    fontWeight: 600,
    // A badge's words stay whole and the badge keeps its natural width in a table column; only a word longer than the space, such as a shared link, breaks rather than widening a phone's page.
    maxWidth: "100%",
    overflowWrap: "break-word",
    border: "1px solid currentColor",
  },
  variants: {
    tone: {
      neutral: { color: vars.color.textMuted, background: vars.color.surface },
      success: { color: vars.color.success, background: vars.color.successSubtle },
      warning: { color: vars.color.warning, background: vars.color.warningSubtle },
      danger: { color: vars.color.danger, background: vars.color.dangerSubtle },
      simulated: { color: vars.color.simulated, background: vars.color.simulatedSubtle },
    },
  },
  defaultVariants: { tone: "neutral" },
});
