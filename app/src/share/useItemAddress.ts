import { encodeShare, type ShareEnvelope } from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { useEffect } from "react";

/**
 * Moves the address from an open Library item's id to the item's sharing link, so the address is the one link an item has. While `key` names an open item and the address holds no link, the item is read when the browser is idle and encoded with identifying values removed (the share dialog's own default), and `setFragment` puts the result in the address. An item whose link cannot be made (too long to carry) keeps its id in the address, which is then its only link.
 *
 * @param key Names the open item whose address has no link yet, or undefined.
 * @param load Builds the envelope of the open item. Called again only when `key` changes.
 * @param setFragment Puts the `share=...` fragment in the address for the item named by its first argument.
 */
export function useItemAddress(
  key: string | undefined,
  load: () => Promise<ShareEnvelope>,
  setFragment: (item: string, fragment: string) => void,
): void {
  useEffect(() => {
    if (key === undefined) return;
    const live = { active: true };
    // The link is a convenience, so it waits for the browser to be idle and never delays the item's own first paint.
    const idle = new Promise<void>((resolve) => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(
          () => {
            resolve();
          },
          { timeout: 1000 },
        );
      } else setTimeout(resolve, 0);
    });
    idle
      .then(load)
      .then((envelope) => encodeShare(envelope, streamShareCodec, { redactVin: true }))
      .then(
        (encoded) => {
          if (live.active && encoded.ok) setFragment(key, encoded.value.fragment);
        },
        () => undefined,
      );
    return () => {
      live.active = false;
    };
    // `load` and `setFragment` are rebuilt every render; the item `key` decides when the link is made again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
