import type { Vehicle } from "obd-read";

/** A day in milliseconds. */
export const DAY = 86_400_000;

/** A vehicle as a list or a choice names it: its name and VIN, its VIN alone, or that neither is known. */
export function vehicleName(vehicle: Vehicle): string {
  if (vehicle.label !== "" && vehicle.vin !== null) return `${vehicle.label} (${vehicle.vin})`;
  return vehicle.label !== "" ? vehicle.label : (vehicle.vin ?? "A car with no VIN");
}

/** A moment's UTC day as a date field writes it, `YYYY-MM-DD`. */
export function dayInput(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The start of the UTC day a date field holds, or undefined while it holds none. */
export function dayOfInput(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(at) ? undefined : at;
}
