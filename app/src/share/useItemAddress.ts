import { encodeShare, type ShareEnvelope } from "obd-read";
import { streamShareCodec } from "obd-read/web";
import { useEffect, useState } from "react";

/** Whether the open item is stored on this device: not known yet, read, or not there. */
export type LocalItem = "loading" | "found" | "missing";

/**
 * Keeps the address bar on the sharing link of the open Library item, and says whether the item is stored here. While `load` is given, its envelope is read and encoded with identifying values removed (the share dialog's own default) and `setFragment` puts the result in the address, so copying the address shares the item; an item whose link cannot be made (too long to carry) leaves the address without a fragment. An item that cannot be read is `missing`, and the address is left as it is, because a link that carries someone else's data names an item this device does not have.
 *
 * @param key Names the open item, so its link is made once for it; undefined when none is open.
 * @param load Builds the envelope of the open item. Called again only when `key` changes.
 * @param setFragment Puts a `share=...` fragment in the address, or removes it with undefined.
 */
export function useItemAddress(
  key: string | undefined,
  load: () => Promise<ShareEnvelope>,
  setFragment: (fragment: string | undefined) => void,
): LocalItem {
  const [state, setState] = useState<
    { readonly key: string; readonly status: LocalItem } | undefined
  >(undefined);
  useEffect(() => {
    if (key === undefined) return;
    const live = { active: true };
    load().then(
      (envelope) => {
        if (!live.active) return;
        setState({ key, status: "found" });
        void encodeShare(envelope, streamShareCodec, { redactVin: true }).then((encoded) => {
          if (live.active) setFragment(encoded.ok ? encoded.value.fragment : undefined);
        });
      },
      () => {
        if (live.active) setState({ key, status: "missing" });
      },
    );
    return () => {
      live.active = false;
    };
    // `load` and `setFragment` are rebuilt every render; the item `key` decides when the link is made again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key === undefined ? "loading" : state?.key === key ? state.status : "loading";
}
