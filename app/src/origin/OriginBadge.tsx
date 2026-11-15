import type { Origin } from "obd-read";
import { Badge } from "../ui";
import { ORIGIN_LABELS } from "./origins";

/** Where a stored record came from, as a badge: read here, shared from a link (marked as a warning) or imported from a file. */
export function OriginBadge({ origin }: { readonly origin: Origin }) {
  return <Badge tone={origin === "local" ? "neutral" : "warning"}>{ORIGIN_LABELS[origin]}</Badge>;
}
