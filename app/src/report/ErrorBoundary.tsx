import { Component, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "../ui";
import { errorStore, type CapturedError, type ErrorStore } from "./capture";
import type { ScreenId } from "./events";
import { ReportDialog } from "./ReportDialog";
import { buttons, fallback, fallbackTitle, root } from "./report.css";

/** What an {@link ErrorBoundary} gives its fallback. */
export interface FallbackProps {
  /** Shows the boundary's children again. They fail again if the cause is still there. */
  readonly reset: () => void;
}

/** Props of {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  /** Where the boundary is, for the report. */
  readonly screen: ScreenId;
  /** Shown instead of the children after one of them threw. */
  readonly fallback: (props: FallbackProps) => ReactNode;
  /** Where the error is recorded; the app's store unless a test gives its own. */
  readonly store?: ErrorStore;
  /** The children are shown again whenever one of these changes. */
  readonly resetKeys?: readonly unknown[];
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
}

function keysChanged(before: readonly unknown[] = [], after: readonly unknown[] = []): boolean {
  return (
    before.length !== after.length || before.some((key, index) => !Object.is(key, after[index]))
  );
}

/**
 * Catches errors thrown while rendering its children and shows `fallback` in their place; everything outside it keeps working. The error goes to the store with the screen it came from.
 *
 * It shows the children again after `reset` or when `resetKeys` change. Errors in event handlers and in asynchronous code are not caught by React boundaries; the global handlers in `capture.ts` cover those.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    (this.props.store ?? errorStore).capture("react", error, true, this.props.screen);
  }

  override componentDidUpdate(before: ErrorBoundaryProps): void {
    if (this.state.failed && keysChanged(before.resetKeys, this.props.resetKeys)) this.reset();
  }

  readonly reset = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback({ reset: this.reset }) : this.props.children;
  }
}

function useLatestError(store: ErrorStore): CapturedError | undefined {
  return useSyncExternalStore(store.subscribe, store.getState).latest;
}

/** The label the fallbacks use for each place. */
export const SCREEN_LABELS: Readonly<Record<ScreenId, string>> = {
  connect: "Connect",
  scan: "Scan",
  live: "Live",
  runs: "Runs",
  captures: "Captures",
  settings: "Settings",
  shared: "Shared data",
  app: "obd-read",
};

/** Props of {@link ScreenFallback}. */
export interface ScreenFallbackProps extends FallbackProps {
  readonly screen: ScreenId;
  readonly store?: ErrorStore;
  /** Leaves the failed screen for Connect; omitted on Connect itself. */
  readonly onGoToConnect?: (() => void) | undefined;
}

/** What a failed screen shows: what happened, and what the user can do. The rest of the app is still working. */
export function ScreenFallback({
  screen,
  reset,
  onGoToConnect,
  store = errorStore,
}: ScreenFallbackProps) {
  const error = useLatestError(store);
  const [reporting, setReporting] = useState(false);
  return (
    <section className={fallback} role="alert" aria-labelledby={`fallback-${screen}`}>
      <h1 id={`fallback-${screen}`} className={fallbackTitle}>
        {SCREEN_LABELS[screen]} could not be shown
      </h1>
      <p>
        Something went wrong while showing this screen. The rest of the app, your connection and any
        run in progress are still working.
      </p>
      <div className={buttons}>
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        {onGoToConnect !== undefined && <Button onClick={onGoToConnect}>Go to Connect</Button>}
        <Button
          onClick={() => {
            setReporting(true);
          }}
        >
          Report this problem
        </Button>
      </div>
      {error !== undefined && (
        <ReportDialog open={reporting} onOpenChange={setReporting} error={error} />
      )}
    </section>
  );
}

/** What the whole app shows when something above the screens failed. It needs no provider, so it works when they are what failed. */
export function RootFallback({
  reset,
  store = errorStore,
}: FallbackProps & { readonly store?: ErrorStore }) {
  const error = useLatestError(store);
  const [reporting, setReporting] = useState(false);
  return (
    <div className={root}>
      <section className={fallback} role="alert" aria-labelledby="fallback-app">
        <h1 id="fallback-app" className={fallbackTitle}>
          obd-read hit a problem
        </h1>
        <p>
          The page stopped showing the app. Saved scans and runs are untouched, and a run in
          progress carries on in its worker. Nothing was sent anywhere.
        </p>
        <div className={buttons}>
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <Button
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload the app
          </Button>
          <Button
            onClick={() => {
              setReporting(true);
            }}
          >
            Report this problem
          </Button>
        </div>
        {error !== undefined && (
          <ReportDialog open={reporting} onOpenChange={setReporting} error={error} />
        )}
      </section>
    </div>
  );
}

/** A boundary around the whole app. */
export function RootBoundary({
  children,
  store,
}: {
  readonly children: ReactNode;
  readonly store?: ErrorStore;
}) {
  return (
    <ErrorBoundary
      screen="app"
      {...(store === undefined ? {} : { store })}
      fallback={({ reset }) => (
        <RootFallback reset={reset} {...(store === undefined ? {} : { store })} />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
