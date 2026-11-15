import type { ButtonHTMLAttributes } from "react";
import { button, type ButtonVariants } from "./Button.css";

/** Props of {@link Button}: a native button's props plus the style variants. */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & ButtonVariants;

/**
 * A native button with a 44 px minimum touch target. `type` defaults to "button" so it never
 * submits a form unasked.
 */
export function Button({ variant, block, type = "button", className, ...rest }: ButtonProps) {
  const classes = [button({ variant, block }), className].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...rest} />;
}
