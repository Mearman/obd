import { useEffect } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import type { StorageSource } from "./storage-source";

/** Tells the service worker's storage what the page's database is: opening, ready or unusable. Renders nothing. */
export function StorageBridge({ source }: { readonly source: StorageSource }) {
  const { state } = useDatabase();
  useEffect(() => {
    if (state.status === "ready") source.ready(state.storage);
    else if (state.status === "unavailable") source.unavailable();
    else source.opening();
  }, [source, state]);
  return null;
}
