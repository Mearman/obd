import type { SqlMessage, SqlMessagePort } from "obd-read/web/storage";

/**
 * Two connected {@link SqlMessagePort}s standing in for a page and its worker: a message posted on one is structured-cloned and delivered asynchronously to the other's listeners, as a real `MessageChannel` does.
 */
export function messagePair(): readonly [SqlMessagePort, SqlMessagePort] {
  type Listener = (event: { readonly data: unknown }) => void;
  const listeners: [Set<Listener>, Set<Listener>] = [new Set(), new Set()];
  const side = (self: 0 | 1): SqlMessagePort => ({
    postMessage(message: SqlMessage) {
      const delivered: unknown = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of listeners[self === 0 ? 1 : 0]) listener({ data: delivered });
      });
    },
    addEventListener(_type, listener) {
      listeners[self].add(listener);
    },
    removeEventListener(_type, listener) {
      listeners[self].delete(listener);
    },
  });
  return [side(0), side(1)];
}
