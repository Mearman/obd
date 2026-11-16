import { OBD_REPORT_FORMAT, type Json } from "obd-read";

/** Whether a saved report's body is a generic OBD-II read (`obd --output`) rather than a per-unit scan. */
export function isObdRead(report: Json): boolean {
  return (
    typeof report === "object" &&
    report !== null &&
    !Array.isArray(report) &&
    report.format === OBD_REPORT_FORMAT
  );
}
