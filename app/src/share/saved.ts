/** What a shared link's viewer can save. */
export type SavedShare = "scan" | "capture";

/** The notice shown once a shared item is saved. */
export const SAVED_NOTICES: Readonly<
  Record<SavedShare, { readonly title: string; readonly description: string }>
> = {
  scan: {
    title: "Saved the shared scan",
    description: "It is stored as a scan report marked as shared.",
  },
  capture: {
    title: "Saved the shared capture",
    description: "It is stored with your captures and opens in the Captures viewer.",
  },
};
