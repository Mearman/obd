import type { ReactNode } from "react";
import { card, cardDescription, cardTitle } from "./Card.css";

/** Props of {@link Card}. */
export interface CardProps {
  readonly title?: string;
  readonly description?: string;
  readonly children?: ReactNode;
}

/** A bordered surface that groups related content under an optional title and description. */
export function Card({ title, description, children }: CardProps) {
  return (
    <section className={card}>
      {title !== undefined && <h2 className={cardTitle}>{title}</h2>}
      {description !== undefined && <p className={cardDescription}>{description}</p>}
      {children}
    </section>
  );
}
