import { recipe, type RecipeVariants } from "@vanilla-extract/recipes";
import { vars } from "../theme/contract.css";

export const button = recipe({
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: vars.space["2"],
    minHeight: vars.size.touch,
    minWidth: vars.size.touch,
    paddingInline: vars.space["4"],
    borderRadius: vars.radius.medium,
    border: "1px solid transparent",
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "none",
    selectors: { "&:disabled": { opacity: 0.55, cursor: "not-allowed" } },
  },
  variants: {
    variant: {
      primary: {
        background: vars.color.accent,
        color: vars.color.accentText,
        selectors: { "&:hover:not(:disabled)": { background: vars.color.accentHover } },
      },
      secondary: {
        background: vars.color.surface,
        color: vars.color.text,
        borderColor: vars.color.border,
        selectors: { "&:hover:not(:disabled)": { background: vars.color.accentSubtle } },
      },
      ghost: {
        background: "transparent",
        color: vars.color.accent,
        selectors: { "&:hover:not(:disabled)": { background: vars.color.accentSubtle } },
      },
    },
    block: { true: { width: "100%" } },
  },
  defaultVariants: { variant: "secondary" },
});

export type ButtonVariants = NonNullable<RecipeVariants<typeof button>>;
