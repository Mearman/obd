import { useId, useState, type ReactNode } from "react";
import { body, chevron, collapsible, heading, trigger } from "./Collapsible.css";

/** Props of {@link Collapsible}. */
export interface CollapsibleProps {
  readonly title: string;
  /** Whether it starts expanded; it then keeps its own expanded state. */
  readonly defaultExpanded?: boolean;
  readonly children: ReactNode;
}

/**
 * A bordered surface whose content is shown or hidden by pressing its heading.
 *
 * The content stays mounted while it is hidden, so anything typed into it, and any operation it started, survives collapsing.
 */
export function Collapsible({ title, defaultExpanded = false, children }: CollapsibleProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const id = useId();
  return (
    <section className={collapsible} aria-labelledby={`${id}-trigger`}>
      <h2 className={heading}>
        <button
          id={`${id}-trigger`}
          type="button"
          className={trigger}
          aria-expanded={expanded}
          aria-controls={`${id}-body`}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {title}
          <span className={chevron} aria-hidden="true">
            ▾
          </span>
        </button>
      </h2>
      <div id={`${id}-body`} className={body} hidden={!expanded}>
        {children}
      </div>
    </section>
  );
}
