/** What the page posts to the service worker when it starts: the ports the worker serves and uses. */
export interface WorkerInit {
  /** The port the worker serves the diagnostics service on. */
  readonly diagnostics: MessagePort;
  /** The port the page serves its transports on, for the worker to use. */
  readonly transports: MessagePort;
  /** The port the page serves its storage on, for the worker to use. */
  readonly storage: MessagePort;
}

/** Reads the start-up message, or returns undefined for any other message. */
export function readWorkerInit(data: unknown): WorkerInit | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("diagnostics" in data) || !("transports" in data) || !("storage" in data)) return undefined;
  const { diagnostics, transports, storage } = data;
  if (
    !(diagnostics instanceof MessagePort) ||
    !(transports instanceof MessagePort) ||
    !(storage instanceof MessagePort)
  ) {
    return undefined;
  }
  return { diagnostics, transports, storage };
}
