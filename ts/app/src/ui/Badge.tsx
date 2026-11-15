import type { ReactNode } from "react";
import { badge } from "./Badge.css";

/** The meaning a {@link Badge} colours. */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "simulated";

/** A short status label. Colour never carries the meaning alone: the text always says it. */
export function Badge({
  tone,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
}) {
  return <span className={badge({ tone })}>{children}</span>;
}
