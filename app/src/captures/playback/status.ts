import type { ExchangeStatus } from "obd-read";

/** How each way an exchange can end is named on screen, always in words beside any colour. */
export const STATUS_LABELS: Readonly<Record<ExchangeStatus, string>> = {
  answered: "Answered",
  negative: "Refused",
  unanswered: "No answer",
};

/** The shape that marks each way an exchange can end, so colour is never the only cue. */
export const STATUS_GLYPHS: Readonly<Record<ExchangeStatus, string>> = {
  answered: "●",
  negative: "▲",
  unanswered: "✕",
};
