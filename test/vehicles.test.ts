import { describe, expect, it } from "vitest";
import {
  StorageError,
  checkRegister,
  formatPlate,
  plateAt,
  identifyVehicle,
  mergeVehicles,
  normalisePlate,
  recordSighting,
  withPlate,
  withNewPlate,
  withVehicle,
  type PlateAssignment,
  type VehicleRegister,
} from "../src/core/index.js";

/** Invented VINs and plates for three cars. */
const ESTATE = "WDB2110202B000001";
const HATCH = "WVWZZZ6RZAY000002";
const COUPE = "WBA3A5C50CF000003";
const PLATE = "AB12CDE";
const OTHER = "XY65ZZZ";

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

const EMPTY: VehicleRegister = { vehicles: [], plates: [] };

/** Ids in the order they are asked for: `v1`, `v2`, and so on. */
function counter(): () => string {
  let next = 0;
  return () => `v${String((next += 1))}`;
}

/** Records each sighting in turn, returning the vehicle of each and the register they leave. */
function recordAll(
  register: VehicleRegister,
  sightings: readonly { vin: string | null; plate: string | null; at: number }[],
  newId: () => string = counter(),
): { readonly ids: (string | undefined)[]; readonly register: VehicleRegister } {
  const ids: (string | undefined)[] = [];
  let current = register;
  for (const sighting of sightings) {
    const recorded = recordSighting(current, sighting, newId);
    ids.push(recorded.vehicleId);
    current = recorded.register;
  }
  return { ids, register: current };
}

/** Each assignment as `plate vehicle from to`, the times as days after T0, for reading at a glance. */
function periods(register: VehicleRegister): string[] {
  const day = (at: number | null) => (at === null ? "-" : String((at - T0) / DAY));
  return register.plates.map(
    (a) => `${a.plate} ${a.vehicleId} ${day(a.validFrom)} ${day(a.validTo)}`,
  );
}

describe("number plates", () => {
  it("keeps a plate upper case without spaces or hyphens, and a blank one as none", () => {
    expect(normalisePlate(" ab12 cde ")).toBe(PLATE);
    expect(normalisePlate("AB12-CDE")).toBe(PLATE);
    expect(normalisePlate(" - ")).toBeNull();
    expect(normalisePlate(null)).toBeNull();
  });

  it("shows a plate in the UK format it fits, and any other as stored", () => {
    expect(formatPlate("AB12CDE")).toBe("AB12 CDE");
    expect(formatPlate("A123BCD")).toBe("A123 BCD");
    expect(formatPlate("ABC123D")).toBe("ABC 123D");
    expect(formatPlate("ABC123")).toBe("ABC 123");
    expect(formatPlate("123ABC")).toBe("123 ABC");
    expect(formatPlate("WDB2110202")).toBe("WDB2110202");
  });
});

describe("recording a sighting", () => {
  it("adds a vehicle for a VIN seen first, with its plate from then on", () => {
    const { ids, register } = recordAll(EMPTY, [{ vin: ESTATE, plate: PLATE, at: T0 }]);
    expect(ids).toEqual(["v1"]);
    expect(register.vehicles).toEqual([{ id: "v1", vin: ESTATE, label: "" }]);
    expect(periods(register)).toEqual([`${PLATE} v1 0 -`]);
  });

  it("changes nothing when the same car is seen again with the same plate", () => {
    const first = recordAll(EMPTY, [{ vin: ESTATE, plate: PLATE, at: T0 }]).register;
    const again = recordSighting(first, { vin: ESTATE, plate: PLATE, at: T0 + DAY }, counter());
    expect(again.vehicleId).toBe("v1");
    expect(again.register).toEqual(first);
  });

  it("moves a plate to another car: the first car's period ends where the second's begins", () => {
    const { ids, register } = recordAll(EMPTY, [
      { vin: ESTATE, plate: PLATE, at: T0 },
      { vin: HATCH, plate: PLATE, at: T0 + 10 * DAY },
    ]);
    expect(ids).toEqual(["v1", "v3"]);
    expect(periods(register)).toEqual([`${PLATE} v1 0 10`, `${PLATE} v3 10 -`]);
    // The plate names each car at its own time.
    expect(identifyVehicle(register, { vin: null, plate: PLATE, at: T0 + DAY }).vehicle?.id).toBe(
      "v1",
    );
    expect(
      identifyVehicle(register, { vin: null, plate: PLATE, at: T0 + 20 * DAY }).vehicle?.id,
    ).toBe("v3");
  });

  it("identifies a car by its plate alone at the item's time, and records nothing for it", () => {
    const known = recordAll(EMPTY, [{ vin: ESTATE, plate: PLATE, at: T0 }]).register;
    const seen = recordSighting(known, { vin: null, plate: PLATE, at: T0 + DAY }, counter());
    expect(seen.vehicleId).toBe("v1");
    expect(seen.register).toEqual(known);
    expect(identifyVehicle(known, { vin: null, plate: PLATE, at: T0 + DAY })).toEqual({
      vehicle: { id: "v1", vin: ESTATE, label: "" },
      vin: ESTATE,
      plate: PLATE,
    });
    // A plate the register does not hold names no car.
    expect(recordSighting(known, { vin: null, plate: OTHER, at: T0 }, counter()).vehicleId).toBe(
      undefined,
    );
  });

  it("leaves a plate held by two vehicles at once unresolved rather than guess", () => {
    // Only a register written past its own checks holds this, as a hand-edited database might.
    const contradictory: VehicleRegister = {
      vehicles: [
        { id: "a", vin: ESTATE, label: "" },
        { id: "b", vin: HATCH, label: "" },
      ],
      plates: [
        { id: "p1", vehicleId: "a", plate: PLATE, validFrom: null, validTo: null },
        { id: "p2", vehicleId: "b", plate: PLATE, validFrom: T0, validTo: null },
      ],
    };
    expect(() => {
      checkRegister(contradictory);
    }).toThrow(/AB12 CDE.*overlap/);
    const seen = identifyVehicle(contradictory, { vin: null, plate: PLATE, at: T0 + DAY });
    expect(seen.vehicle).toBeUndefined();
    expect(seen.vin).toBeNull();
    expect(seen.plate).toBe(PLATE);
    expect(
      recordSighting(contradictory, { vin: null, plate: PLATE, at: T0 + DAY }, counter()).vehicleId,
    ).toBeUndefined();
  });

  it("gives a re-registered car its new plate, ending its old one then", () => {
    const newId = counter();
    const { register } = recordAll(
      EMPTY,
      [
        { vin: ESTATE, plate: PLATE, at: T0 },
        { vin: ESTATE, plate: OTHER, at: T0 + 30 * DAY },
      ],
      newId,
    );
    expect(periods(register)).toEqual([`${PLATE} v1 0 30`, `${OTHER} v1 30 -`]);
    // The old plate is free for another car from then on, and the re-registered car keeps its new one.
    const moved = recordAll(
      register,
      [{ vin: HATCH, plate: PLATE, at: T0 + 40 * DAY }],
      newId,
    ).register;
    expect(periods(moved)).toEqual([`${PLATE} v1 0 30`, `${PLATE} v4 40 -`, `${OTHER} v1 30 -`]);
  });

  it("finds no car for an item older than any assignment, and an old sighting never overwrites a later one", () => {
    const newId = counter();
    const { register } = recordAll(
      EMPTY,
      [
        { vin: ESTATE, plate: PLATE, at: T0 + 10 * DAY },
        { vin: HATCH, plate: PLATE, at: T0 + 20 * DAY },
      ],
      newId,
    );
    expect(identifyVehicle(register, { vin: null, plate: PLATE, at: T0 }).vehicle).toBeUndefined();
    // An older item of a third car with the plate takes it only until the first known period.
    const older = recordAll(register, [{ vin: COUPE, plate: PLATE, at: T0 }], newId).register;
    expect(periods(older)).toEqual([`${PLATE} v5 0 10`, `${PLATE} v1 10 20`, `${PLATE} v3 20 -`]);
    expect(identifyVehicle(older, { vin: null, plate: PLATE, at: T0 }).vehicle?.vin).toBe(COUPE);
  });

  it("brings its own later period forward when a car is seen earlier with the same plate", () => {
    const { register } = recordAll(EMPTY, [
      { vin: ESTATE, plate: PLATE, at: T0 + 10 * DAY },
      { vin: ESTATE, plate: PLATE, at: T0 },
    ]);
    expect(periods(register)).toEqual([`${PLATE} v1 0 -`]);
  });

  it("adds a vehicle for a VIN with no plate, and leaves the register for a sighting of neither", () => {
    const { ids, register } = recordAll(EMPTY, [
      { vin: ESTATE, plate: null, at: T0 },
      { vin: null, plate: null, at: T0 },
    ]);
    expect(ids).toEqual(["v1", undefined]);
    expect(register).toEqual({ vehicles: [{ id: "v1", vin: ESTATE, label: "" }], plates: [] });
  });
});

describe("editing the register", () => {
  const one = recordAll(EMPTY, [{ vin: ESTATE, plate: PLATE, at: T0 }], () => "v1").register;

  it("refuses an assignment that overlaps another of the same plate, naming both periods", () => {
    const clash: PlateAssignment = {
      id: "x",
      vehicleId: "v1",
      plate: "ab12 cde",
      validFrom: null,
      validTo: T0 + DAY,
    };
    const refused = (() => {
      try {
        withPlate(one, clash);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(StorageError);
    expect(refused).toMatchObject({ code: "conflict" });
    expect(String(refused)).toMatch(/AB12 CDE.*an unknown start.*overlap/);
  });

  it("refuses a period that ends before it starts, and one for an unknown vehicle", () => {
    expect(() =>
      withPlate(one, { id: "x", vehicleId: "v1", plate: OTHER, validFrom: T0, validTo: T0 }),
    ).toThrow(StorageError);
    expect(() =>
      withPlate(one, { id: "x", vehicleId: "nope", plate: OTHER, validFrom: T0, validTo: null }),
    ).toThrow(/no vehicle nope/);
  });

  it("gives a car a new plate from a day, ending its open plate then in the same change", () => {
    const added = withNewPlate(
      one,
      { vehicleId: "v1", plate: "xy65 zzz", validFrom: T0 + 3 * DAY },
      () => "n1",
    );
    expect(periods(added)).toEqual([`${PLATE} v1 0 3`, `${OTHER} v1 3 -`]);
    // Giving it a plate from a day it already carried another is refused, and nothing changes.
    expect(() =>
      withNewPlate(added, { vehicleId: "v1", plate: OTHER, validFrom: T0 }, () => "n2"),
    ).toThrow(/at once/);
    expect(() =>
      withNewPlate(one, { vehicleId: "v1", plate: " ", validFrom: null }, () => "n3"),
    ).toThrow(StorageError);
  });

  it("marks a plate moved off a vehicle by ending its period", () => {
    const [assignment] = one.plates;
    if (assignment === undefined) throw new Error("expected an assignment");
    const ended = withPlate(one, { ...assignment, validTo: T0 + 5 * DAY });
    expect(periods(ended)).toEqual([`${PLATE} v1 0 5`]);
    expect(identifyVehicle(ended, { vin: null, plate: PLATE, at: T0 + 6 * DAY }).vehicle).toBe(
      undefined,
    );
  });

  it("refuses a second vehicle with a VIN another has", () => {
    expect(() => withVehicle(one, { id: "v9", vin: ESTATE, label: "" })).toThrow(/belongs to/);
    expect(withVehicle(one, { id: "v1", vin: ESTATE, label: "Estate" }).vehicles).toEqual([
      { id: "v1", vin: ESTATE, label: "Estate" },
    ]);
  });

  it("merges a vehicle known only by its plate into the one with the VIN", () => {
    const byPlate = withPlate(withVehicle(one, { id: "p", vin: null, label: "Blue estate" }), {
      id: "old",
      vehicleId: "p",
      plate: OTHER,
      validFrom: null,
      validTo: T0,
    });
    const merged = mergeVehicles(byPlate, "v1", "p");
    expect(merged.vehicles).toEqual([{ id: "v1", vin: ESTATE, label: "Blue estate" }]);
    expect(periods(merged)).toEqual([`${PLATE} v1 0 -`, `${OTHER} v1 - 0`]);
  });

  it("refuses to merge two vehicles with different VINs, or a vehicle into itself", () => {
    const two = recordAll(one, [{ vin: HATCH, plate: null, at: T0 }], () => "v2").register;
    const [, hatch] = two.vehicles;
    if (hatch === undefined) throw new Error("expected two vehicles");
    expect(() => mergeVehicles(two, "v1", hatch.id)).toThrow(/different VINs/);
    expect(() => mergeVehicles(two, "v1", "v1")).toThrow(/itself/);
  });
});

describe("one car, one plate at a time", () => {
  /** Fails when one vehicle's periods overlap, whatever their plates. */
  function oneAtATime(register: VehicleRegister): void {
    for (const vehicle of register.vehicles) {
      const own = register.plates.filter((each) => each.vehicleId === vehicle.id);
      own.forEach((a, index) => {
        for (const b of own.slice(index + 1)) {
          const apart =
            (a.validTo !== null && b.validFrom !== null && a.validTo <= b.validFrom) ||
            (b.validTo !== null && a.validFrom !== null && b.validTo <= a.validFrom);
          expect(apart, `${a.plate} and ${b.plate} on ${vehicle.id}`).toBe(true);
        }
      });
    }
  }

  it("refuses a register in which one car carries two plates at once", () => {
    expect(() => {
      checkRegister({
        vehicles: [{ id: "v1", vin: ESTATE, label: "" }],
        plates: [
          { id: "a", vehicleId: "v1", plate: PLATE, validFrom: T0, validTo: null },
          { id: "b", vehicleId: "v1", plate: OTHER, validFrom: T0 + DAY, validTo: null },
        ],
      });
    }).toThrow(/vehicle v1 cannot carry .* at once/);
  });

  it("caps an old item's plate where the car's next plate begins", () => {
    const { register } = recordAll(EMPTY, [
      { vin: ESTATE, plate: OTHER, at: T0 + 30 * DAY },
      { vin: ESTATE, plate: PLATE, at: T0 },
    ]);
    oneAtATime(register);
    expect(periods(register)).toEqual([`${PLATE} v1 0 30`, `${OTHER} v1 30 -`]);
    expect(plateAt(register, "v1", T0 + DAY)).toBe(PLATE);
    expect(plateAt(register, "v1", T0 + 40 * DAY)).toBe(OTHER);
  });

  it("leaves the register as it is when an item's plate disagrees with a closed period of the car's own", () => {
    const closed = withPlate(recordAll(EMPTY, [{ vin: ESTATE, plate: null, at: T0 }]).register, {
      id: "q",
      vehicleId: "v1",
      plate: OTHER,
      validFrom: T0,
      validTo: T0 + 30 * DAY,
    });
    const seen = recordSighting(
      closed,
      { vin: ESTATE, plate: PLATE, at: T0 + 10 * DAY },
      counter(),
    );
    expect(seen.register).toEqual(closed);
  });

  it("refuses a new plate of unknown start on a car that has an open plate", () => {
    const one = recordAll(EMPTY, [{ vin: ESTATE, plate: PLATE, at: T0 }], () => "v1").register;
    expect(() =>
      withNewPlate(one, { vehicleId: "v1", plate: OTHER, validFrom: null }, () => "n"),
    ).toThrow(/open plate/);
  });

  it("caps a new plate given from before the car's current one at that one's start", () => {
    const one = recordAll(
      EMPTY,
      [{ vin: ESTATE, plate: PLATE, at: T0 + 10 * DAY }],
      () => "v1",
    ).register;
    const earlier = withNewPlate(one, { vehicleId: "v1", plate: OTHER, validFrom: T0 }, () => "n");
    oneAtATime(earlier);
    expect(periods(earlier)).toEqual([`${PLATE} v1 10 -`, `${OTHER} v1 0 10`]);
  });

  it("caps a new plate of unknown start at the car's first plate when none is open", () => {
    const closed = withPlate(recordAll(EMPTY, [{ vin: ESTATE, plate: null, at: T0 }]).register, {
      id: "q",
      vehicleId: "v1",
      plate: OTHER,
      validFrom: T0 + 5 * DAY,
      validTo: T0 + 9 * DAY,
    });
    const unknown = withNewPlate(
      closed,
      { vehicleId: "v1", plate: PLATE, validFrom: null },
      () => "n",
    );
    oneAtATime(unknown);
    expect(periods(unknown)).toEqual([`${PLATE} v1 - 5`, `${OTHER} v1 5 9`]);
  });
});
