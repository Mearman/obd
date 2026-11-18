import { profilesForVin, type Profile, type VehicleRegister } from "obd-read";
import { useEffect, useState } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
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

/** No vehicles and no plates: what the Library resolves against until the register is read. */
const EMPTY_REGISTER: VehicleRegister = { vehicles: [], plates: [] };

/** The vehicle register as the Library last read it, and why the latest read failed, if it did. */
export interface RegisterListing {
  readonly register: VehicleRegister;
  readonly problem: string | undefined;
}

/** The vehicle register, read again whenever the database changes; empty until the first read, so items show what they recorded until then. A failed read keeps the last register and says why, for the Library to show beside the list. */
export function useVehicleRegister(): RegisterListing {
  const { service } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const [listing, setListing] = useState<RegisterListing>({
    register: EMPTY_REGISTER,
    problem: undefined,
  });

  useEffect(() => {
    let current = true;
    client.vehicles.list().then(
      (register) => {
        if (current) setListing({ register, problem: undefined });
      },
      (caught: unknown) => {
        if (current) {
          setListing((before) => ({
            register: before.register,
            problem: failureMessage(
              caught,
              "The vehicles could not be read, so items show only the VIN and plate they recorded.",
            ),
          }));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [client, revision]);

  return listing;
}
