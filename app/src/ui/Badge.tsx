import type { ReactNode } from "react";
import { badge } from "./Badge.css";

/** The meaning a {@link Badge} colours. */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "simulated";

/** A short status label. Colour never carries the meaning alone: the text always says it. */
export function Badge({
  tone,
  wrap,
  children,
}: {
  readonly tone?: BadgeTone;
  /** Lets a long label, such as a sentence about a shared link, wrap instead of staying on one line. */
  readonly wrap?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <span className={badge({ tone, wrap })} {...(wrap === true ? { "data-wrap": "" } : {})}>
      {children}
    </span>
  );
}
