import { profilesForVin, type Profile } from "obd-read";
import { useEffect, useState } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { availableProfiles } from "../profiles/vin-suggestions";
import type { VehicleLabels } from "./view";

/** The short name of each of `vins` whose maker and model a profile names: that profile's name, the first {@link profilesForVin} gives with a model match. A VIN only a maker matches, or none does, has no short name, since the maker alone does not say which car it is. */
export function vehicleLabels(
  vins: readonly string[],
  profiles: readonly Profile[],
): VehicleLabels {
  return new Map(
    vins.flatMap((vin): [string, string][] => {
      const model = profilesForVin(vin, profiles).find((found) => found.match === "model");
      return model === undefined ? [] : [[vin, model.profile.name]];
    }),
  );
}

/** The short names {@link vehicleLabels} gives `vins` from the shipped and imported profiles; none until those are read, so headings show the VIN alone until then. */
export function useVehicleLabels(vins: readonly string[]): VehicleLabels {
  const { state, revision } = useDatabase();
  const waiting = state.status === "opening";
  const storage = state.status === "ready" ? state.storage : undefined;
  const [profiles, setProfiles] = useState<readonly Profile[]>([]);

  useEffect(() => {
    if (waiting) return;
    let current = true;
    void availableProfiles(storage).then((found) => {
      if (current) setProfiles(found);
    });
    return () => {
      current = false;
    };
  }, [waiting, storage, revision]);

  return vehicleLabels(vins, profiles);
}
