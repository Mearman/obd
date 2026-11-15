import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactElement } from "react";
import { content } from "./Tooltip.css";

/** Wraps the app once so tooltips share their open delay. */
export const TooltipProvider = RadixTooltip.Provider;

/**
 * Shows `text` when `children` is hovered or focused. A tooltip never holds the only copy of
 * information: touch screens do not show it, so the same facts appear in the page too.
 */
export function Tooltip({
  text,
  children,
}: {
  readonly text: string;
  readonly children: ReactElement;
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={content} sideOffset={6}>
          {text}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
