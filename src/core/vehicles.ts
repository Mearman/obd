/**
 * The vehicle register: the cars this device has read, each known by its VIN where one was read, and the number plates each has carried over time.
 *
 * A plate is an assignment of a registration to one vehicle for a period, so a plate can move between vehicles (a cherished plate) and a vehicle can carry several plates in turn (a re-registration). No two assignments of one plate may cover the same moment. Nothing here looks a plate up anywhere: the register holds only what the user typed and what the car reported. This module is platform-free.
 */

import { z } from "zod";
import { StorageError, plateSchema, vinSchema, type Plate, type Vin } from "./storage.js";

/** A time as integer milliseconds since the Unix epoch. */
const timestampSchema = z.number().int().nonnegative();

/**
 * The UK formats a stored plate is shown in, each matching the stored form in the two parts a space separates: the current format (two letters and two digits, then three letters), the prefix format (a letter and up to three digits, then three letters), the suffix format (three letters, then up to three digits and a letter), and the dateless formats of letters then digits and digits then letters.
 */
const UK_FORMATS: readonly RegExp[] = [
  /^([A-Z]{2}[0-9]{2})([A-Z]{3})$/,
  /^([A-Z][0-9]{1,3})([A-Z]{3})$/,
  /^([A-Z]{3})([0-9]{1,3}[A-Z])$/,
  /^([A-Z]{1,3})([0-9]{1,4})$/,
  /^([0-9]{1,4})([A-Z]{1,3})$/,
];

/** How a stored plate reads: with the space of the UK format it fits (`AB12 CDE`, `A123 BCD`, `ABC 123D`, `ABC 123`, `123 ABC`), else as stored. */
export function formatPlate(plate: string): string {
  const format = UK_FORMATS.find((pattern) => pattern.test(plate));
  return format === undefined ? plate : plate.replace(format, "$1 $2");
}

/** One vehicle of the register. */
export const vehicleSchema = z.object({
  id: z.string().min(1),
  /** Its VIN, unique among the vehicles that have one; `null` for a vehicle known only by its plates. */
  vin: vinSchema,
  /** A name the user gave it; may be empty. */
  label: z.string(),
});

/** One vehicle of the register. */
export type Vehicle = z.output<typeof vehicleSchema>;

/** One plate carried by one vehicle for a period: from `validFrom` (included; `null` when the start is not known) to `validTo` (excluded; `null` while it still carries it). */
export const plateAssignmentSchema = z
  .object({
    id: z.string().min(1),
    vehicleId: z.string().min(1),
    plate: plateSchema.pipe(z.string()),
    validFrom: timestampSchema.nullable(),
    validTo: timestampSchema.nullable(),
  })
  .refine(
    (assignment) =>
      assignment.validFrom === null ||
      assignment.validTo === null ||
      assignment.validFrom < assignment.validTo,
    { message: "a plate's period must end after it starts", path: ["validTo"] },
  );

/** One plate carried by one vehicle for a period. */
export type PlateAssignment = z.output<typeof plateAssignmentSchema>;

/** Every vehicle and every plate assignment: what the register holds. */
export const vehicleRegisterSchema = z.object({
  vehicles: z.array(vehicleSchema),
  plates: z.array(plateAssignmentSchema),
});

/** Every vehicle and every plate assignment. */
export type VehicleRegister = z.output<typeof vehicleRegisterSchema>;

/** What a stored item says about the car it was read from: its VIN and the plate recorded with it, if any, and when it was read. */
export interface Sighting {
  readonly vin: Vin;
  readonly plate: Plate;
  readonly at: number;
}

/** Whether `assignment` covers the moment `at`. */
export function covers(assignment: PlateAssignment, at: number): boolean {
  return (
    (assignment.validFrom === null || assignment.validFrom <= at) &&
    (assignment.validTo === null || at < assignment.validTo)
  );
}

/** Whether two assignments' periods share a moment. */
function overlap(a: PlateAssignment, b: PlateAssignment): boolean {
  const startsBeforeEnd = (from: number | null, to: number | null) =>
    from === null || to === null || from < to;
  return startsBeforeEnd(a.validFrom, b.validTo) && startsBeforeEnd(b.validFrom, a.validTo);
}

/** When a moment reads in a message: its UTC day, or how an open end reads. */
function moment(at: number | null, open: string): string {
  return at === null ? open : new Date(at).toISOString().slice(0, 10);
}

/** An assignment's period as a message reads it. */
function period(assignment: PlateAssignment): string {
  return `from ${moment(assignment.validFrom, "an unknown start")} to ${moment(assignment.validTo, "now")}`;
}

/**
 * Checks the register's rules: each VIN belongs to one vehicle, each assignment names a vehicle of the register, no two assignments of one plate cover the same moment, and no vehicle carries two plates at the same moment.
 *
 * @throws StorageError `conflict` naming the VIN, or the plates and both periods, that break a rule.
 */
export function checkRegister(register: VehicleRegister): void {
  const vins = new Map<string, string>();
  for (const vehicle of register.vehicles) {
    if (vehicle.vin === null) continue;
    const other = vins.get(vehicle.vin);
    if (other !== undefined) {
      throw new StorageError(
        "conflict",
        `the VIN ${vehicle.vin} belongs to vehicle ${other} already, so vehicle ${vehicle.id} cannot have it too`,
      );
    }
    vins.set(vehicle.vin, vehicle.id);
  }
  const ids = new Set(register.vehicles.map((vehicle) => vehicle.id));
  register.plates.forEach((assignment, index) => {
    if (!ids.has(assignment.vehicleId)) {
      throw new StorageError("not-found", `no vehicle ${assignment.vehicleId}`);
    }
    for (const other of register.plates.slice(index + 1)) {
      if (!overlap(assignment, other)) continue;
      if (other.plate === assignment.plate) {
        throw new StorageError(
          "conflict",
          `the plate ${formatPlate(assignment.plate)} cannot be on vehicle ${assignment.vehicleId} ${period(assignment)} and on vehicle ${other.vehicleId} ${period(other)}: the periods overlap`,
        );
      }
      if (other.vehicleId === assignment.vehicleId) {
        throw new StorageError(
          "conflict",
          `vehicle ${assignment.vehicleId} cannot carry ${formatPlate(assignment.plate)} ${period(assignment)} and ${formatPlate(other.plate)} ${period(other)} at once: a car carries one plate at a time`,
        );
      }
    }
  });
}

/** The vehicle and plate a stored item is of: the vehicle its VIN names, else the one vehicle whose plate assignment covers the item's time; `undefined` when neither settles it. */
export interface Identified {
  readonly vehicle: Vehicle | undefined;
  /** The item's VIN, or its vehicle's. */
  readonly vin: Vin;
  /** The plate recorded with the item, or the one its vehicle carried at the item's time. */
  readonly plate: Plate;
}

/** The plate `vehicleId` carried at `at`, or `null`. */
export function plateAt(register: VehicleRegister, vehicleId: string, at: number): Plate {
  return (
    register.plates.find(
      (assignment) => assignment.vehicleId === vehicleId && covers(assignment, at),
    )?.plate ?? null
  );
}

/**
 * Which vehicle `sighting` is of, without changing the register: the vehicle with its VIN when it has one; else, when its plate is covered at its time by exactly one assignment, that assignment's vehicle; else no vehicle. Two vehicles holding the plate at that time is a contradiction the register refuses, but a plate with no VIN never guesses between candidates.
 */
export function identifyVehicle(register: VehicleRegister, sighting: Sighting): Identified {
  const byVin =
    sighting.vin === null
      ? undefined
      : register.vehicles.find((vehicle) => vehicle.vin === sighting.vin);
  const candidates =
    sighting.vin !== null || sighting.plate === null
      ? []
      : register.plates.filter(
          (assignment) => assignment.plate === sighting.plate && covers(assignment, sighting.at),
        );
  const byPlate =
    candidates.length === 1
      ? register.vehicles.find((vehicle) => vehicle.id === candidates[0]?.vehicleId)
      : undefined;
  const vehicle = byVin ?? byPlate;
  return {
    vehicle,
    vin: sighting.vin ?? vehicle?.vin ?? null,
    plate:
      sighting.plate ?? (vehicle === undefined ? null : plateAt(register, vehicle.id, sighting.at)),
  };
}

/** What {@link recordSighting} found and the register it leaves. */
export interface Recorded {
  /** The vehicle the sighting is of, or `undefined` when it is unresolved. */
  readonly vehicleId: string | undefined;
  readonly register: VehicleRegister;
}

/**
 * Records what a new item says about its car and returns the register it leaves, which still passes {@link checkRegister}.
 *
 * A VIN finds its vehicle, or adds one. When a plate comes with the VIN and the vehicle does not carry it at the item's time, the vehicle takes it from then: any other vehicle's open assignment of that plate, and this vehicle's own open assignment of another plate, end then (the plate moved, or the car was re-registered). The new assignment ends where the next assignment of that plate or of this vehicle begins, so an old item never overwrites what came after it and a car never carries two plates at once; when that next one is this vehicle's own of the same plate, it is brought forward instead. When a closed assignment, or one starting at that very moment, of the plate or of the vehicle covers the time, the register is left as it is, since the item and the register disagree. Without a VIN nothing changes: the vehicle is identified as {@link identifyVehicle} does.
 *
 * @param newId Gives the id of each vehicle or assignment added.
 */
export function recordSighting(
  register: VehicleRegister,
  sighting: Sighting,
  newId: () => string,
): Recorded {
  if (sighting.vin === null) {
    return { vehicleId: identifyVehicle(register, sighting).vehicle?.id, register };
  }
  const vin = sighting.vin;
  const found = register.vehicles.find((vehicle) => vehicle.vin === vin);
  const vehicle = found ?? { id: newId(), vin, label: "" };
  const vehicles = found === undefined ? [...register.vehicles, vehicle] : register.vehicles;
  const { plate, at } = sighting;
  const unchanged = {
    vehicleId: vehicle.id,
    register: orderedRegister({ vehicles, plates: register.plates }),
  };
  if (plate === null) return unchanged;

  // The assignments in the way: the car's own of any plate, and any car's of this plate.
  const related = register.plates.filter(
    (assignment) => assignment.vehicleId === vehicle.id || assignment.plate === plate,
  );
  const covering = related.filter((assignment) => covers(assignment, at));
  if (
    covering.some((assignment) => assignment.vehicleId === vehicle.id && assignment.plate === plate)
  ) {
    return unchanged;
  }
  // A closed period, or one that starts at this very moment, says otherwise than the item, so the register stands.
  if (covering.some((assignment) => assignment.validTo !== null || assignment.validFrom === at)) {
    return unchanged;
  }
  // The first related assignment after the item: the new one ends where it begins.
  const next = related.reduce<PlateAssignment | undefined>(
    (earliest, assignment) =>
      assignment.validFrom !== null &&
      assignment.validFrom > at &&
      (earliest === undefined ||
        (earliest.validFrom !== null && assignment.validFrom < earliest.validFrom))
        ? assignment
        : earliest,
    undefined,
  );
  const bringForward = next?.vehicleId === vehicle.id && next.plate === plate;
  const plates = register.plates.map((assignment): PlateAssignment => {
    // What covers the time is open and began before it: the plate moved here, or the car was re-registered.
    if (covering.includes(assignment)) return { ...assignment, validTo: at };
    if (bringForward && assignment === next) return { ...assignment, validFrom: at };
    return assignment;
  });
  const added: PlateAssignment[] = bringForward
    ? []
    : [
        {
          id: newId(),
          vehicleId: vehicle.id,
          plate,
          validFrom: at,
          validTo: next?.validFrom ?? null,
        },
      ];
  const recorded = { vehicles, plates: [...plates, ...added] };
  checkRegister(recorded);
  return { vehicleId: vehicle.id, register: orderedRegister(recorded) };
}

/** The register in the order storage lists it: vehicles by id, assignments by plate, then start (an unknown start first), then id. */
export function orderedRegister(register: VehicleRegister): VehicleRegister {
  return {
    vehicles: [...register.vehicles].sort((a, b) => a.id.localeCompare(b.id, "en")),
    plates: [...register.plates].sort(
      (a, b) =>
        a.plate.localeCompare(b.plate, "en") ||
        (a.validFrom ?? -Infinity) - (b.validFrom ?? -Infinity) ||
        a.id.localeCompare(b.id, "en"),
    ),
  };
}

/**
 * The register with `vehicle` stored under its id, its VIN normalised.
 *
 * @throws StorageError `conflict` when another vehicle has its VIN.
 */
export function withVehicle(register: VehicleRegister, vehicle: Vehicle): VehicleRegister {
  const checked = vehicleSchema.parse(vehicle);
  const others = register.vehicles.filter((each) => each.id !== checked.id);
  const result = { vehicles: [...others, checked], plates: register.plates };
  checkRegister(result);
  return orderedRegister(result);
}

/**
 * The register with `assignment` stored under its id, its plate normalised.
 *
 * @throws StorageError `invalid` for a period that ends before it starts or a blank plate, `not-found` for an unknown vehicle, `conflict` when the plate is assigned for an overlapping period already.
 */
export function withPlate(register: VehicleRegister, assignment: PlateAssignment): VehicleRegister {
  const parsed = plateAssignmentSchema.safeParse(assignment);
  if (!parsed.success) {
    throw new StorageError("invalid", `plate assignment ${assignment.id}: ${parsed.error.message}`);
  }
  const others = register.plates.filter((each) => each.id !== parsed.data.id);
  const result = { vehicles: register.vehicles, plates: [...others, parsed.data] };
  checkRegister(result);
  return orderedRegister(result);
}

/** A plate a person gives a vehicle from a day: what {@link withNewPlate} adds. */
export const newPlateSchema = z.object({
  vehicleId: z.string().min(1),
  plate: plateSchema.pipe(z.string()),
  /** When the vehicle started carrying it; `null` when that is not known. */
  validFrom: timestampSchema.nullable(),
});

/** A plate a person gives a vehicle from a day. */
export type NewPlate = z.input<typeof newPlateSchema>;

/**
 * The register with `added` on its vehicle from its start, in one change: the vehicle's open plate that began before then ends then, as when a car is re-registered, and the new plate ends where the vehicle's next plate begins, or stays open when none follows, so the car carries one plate at a time.
 *
 * @throws StorageError `invalid` for a blank plate, or an unknown start on a car that has an open plate (which would leave two open), `not-found` for an unknown vehicle, `conflict` when the plate is assigned for an overlapping period already or the car carries another plate at its start.
 */
export function withNewPlate(
  register: VehicleRegister,
  added: NewPlate,
  newId: () => string,
): VehicleRegister {
  const parsed = newPlateSchema.safeParse(added);
  if (!parsed.success) throw new StorageError("invalid", `new plate: ${parsed.error.message}`);
  const { vehicleId, plate, validFrom } = parsed.data;
  const own = register.plates.filter((assignment) => assignment.vehicleId === vehicleId);
  const open = own.find((assignment) => assignment.validTo === null);
  if (validFrom === null && open !== undefined) {
    throw new StorageError(
      "invalid",
      `vehicle ${vehicleId} has an open plate, ${formatPlate(open.plate)}; give the day the new plate started`,
    );
  }
  const endsOpen =
    validFrom !== null &&
    open !== undefined &&
    (open.validFrom === null || open.validFrom < validFrom);
  const next = own
    .flatMap((assignment) =>
      assignment.validFrom !== null && (validFrom === null || assignment.validFrom > validFrom)
        ? [assignment.validFrom]
        : [],
    )
    .reduce<number | null>(
      (earliest, start) => (earliest === null || start < earliest ? start : earliest),
      null,
    );
  const plates = register.plates.map((assignment) =>
    endsOpen && assignment === open ? { ...assignment, validTo: validFrom } : assignment,
  );
  return withPlate(
    { vehicles: register.vehicles, plates },
    { id: newId(), vehicleId, plate, validFrom, validTo: next },
  );
}

/** The register without the plate assignment `id`. */
export function withoutPlate(register: VehicleRegister, id: string): VehicleRegister {
  return { vehicles: register.vehicles, plates: register.plates.filter((each) => each.id !== id) };
}

/**
 * The register with `removeId` merged into `keepId`, for two records that turned out to be one car: the kept vehicle takes the other's plates, its VIN when it has none, and its label when its own is empty.
 *
 * @throws StorageError `not-found` for an unknown vehicle, `invalid` for a vehicle merged into itself, and `conflict` when both have VINs that differ or the plates they carried overlap.
 */
export function mergeVehicles(
  register: VehicleRegister,
  keepId: string,
  removeId: string,
): VehicleRegister {
  if (keepId === removeId) throw new StorageError("invalid", "a vehicle cannot merge into itself");
  const keep = register.vehicles.find((vehicle) => vehicle.id === keepId);
  const remove = register.vehicles.find((vehicle) => vehicle.id === removeId);
  if (keep === undefined) throw new StorageError("not-found", `no vehicle ${keepId}`);
  if (remove === undefined) throw new StorageError("not-found", `no vehicle ${removeId}`);
  if (keep.vin !== null && remove.vin !== null && keep.vin !== remove.vin) {
    throw new StorageError(
      "conflict",
      `vehicles ${keepId} and ${removeId} have different VINs (${keep.vin} and ${remove.vin}), so they are not one car`,
    );
  }
  const merged: Vehicle = {
    id: keep.id,
    vin: keep.vin ?? remove.vin,
    label: keep.label === "" ? remove.label : keep.label,
  };
  const result = {
    vehicles: register.vehicles.flatMap((vehicle) =>
      vehicle.id === removeId ? [] : vehicle.id === keepId ? [merged] : [vehicle],
    ),
    plates: register.plates.map((assignment) =>
      assignment.vehicleId === removeId ? { ...assignment, vehicleId: keepId } : assignment,
    ),
  };
  checkRegister(result);
  return orderedRegister(result);
}
