import { useEffect, type ReactNode } from "react";
import { errorStore } from "./capture";
import { E2eFaultPoint } from "./e2e-fault";
import { ErrorBoundary, ScreenFallback } from "./ErrorBoundary";
import { recordEvent, type ScreenId } from "./events";

/** Props of {@link ScreenBoundary}. */
export interface ScreenBoundaryProps {
  readonly screen: ScreenId;
  /** Leaves the screen for Connect, offered by the fallback; omit on Connect itself. */
  readonly onGoToConnect?: () => void;
  /** The screen is shown again when one of these changes. */
  readonly resetKeys?: readonly unknown[];
  readonly children: ReactNode;
}

/**
 * Wraps one screen so that a failure in it shows a contained fallback and leaves the rest of the app alone. A screen's boundary is mounted whenever the screen is, so leaving and returning also shows it afresh. Records the visit in the event log.
 */
export function ScreenBoundary({
  screen,
  onGoToConnect,
  resetKeys,
  children,
}: ScreenBoundaryProps) {
  useEffect(() => {
    recordEvent({ kind: "screen", screen });
    errorStore.setScreen(screen);
  }, [screen]);
  return (
    <ErrorBoundary
      screen={screen}
      {...(resetKeys === undefined ? {} : { resetKeys })}
      fallback={({ reset }) => (
        <ScreenFallback screen={screen} reset={reset} onGoToConnect={onGoToConnect} />
      )}
    >
      {import.meta.env.VITE_OBD_E2E === "1" && <E2eFaultPoint screen={screen} />}
      {children}
    </ErrorBoundary>
  );
}
