import { useEffect } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { useUpdates } from "./UpdatesProvider";

/**
 * Opens the database again when the tab that kept it from this one has caught up.
 *
 * A tab whose database is held by an older version of the app, which cannot share it, reports it in use. When another tab announces this tab's own version, an older tab has reloaded onto it, so this tab tries again and joins it in sharing the database. Renders nothing.
 */
export function DatabaseCatchUp() {
  const { updater } = useUpdates();
  const { state, retry } = useDatabase();
  const blocked = state.status === "unavailable" && state.problem === "in-use";
  useEffect(() => {
    if (!blocked) return;
    const version = updater.status().version;
    return updater.onPeer((peer) => {
      if (peer === version) retry();
    });
  }, [blocked, retry, updater]);
  return null;
}
