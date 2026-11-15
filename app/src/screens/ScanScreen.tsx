import { CaptureCard } from "../captures/CaptureCard";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { AdvancedSection } from "./scan/AdvancedSection";
import { ReadCard } from "./scan/ReadCard";
import { page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

/**
 * Scan: read every unit of the connection's profile (or, with no profile, the legislated OBD-II services), capture every raw exchange, then optionally change the car in two steps.
 *
 * @param onCaptured Called with a capture's id once it is stored, to open it.
 */
export function ScanScreen({ onCaptured }: { readonly onCaptured?: (id: string) => void } = {}) {
  const { connection } = useDiagnostics();
  return (
    <div className={page}>
      <ScreenHeading simulated={connection?.simulated === true}>Scan</ScreenHeading>
      <ReadCard stopRunHint="Stop it on the Live screen." />
      <CaptureCard {...(onCaptured === undefined ? {} : { onSaved: onCaptured })} />
      <AdvancedSection defaultExpanded />
    </div>
  );
}
