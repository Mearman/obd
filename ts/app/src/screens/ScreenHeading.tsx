import type { ReactNode } from "react";
import { Badge } from "../ui";
import { heading, title } from "./screen.css";

/** The screen's title, with a "Simulated data" badge when what it shows is not from a car. */
export function ScreenHeading({
  children,
  simulated,
}: {
  readonly children: ReactNode;
  readonly simulated?: boolean;
}) {
  return (
    <div className={heading}>
      <h1 className={title}>{children}</h1>
      {simulated === true && <Badge tone="simulated">Simulated data</Badge>}
    </div>
  );
}
