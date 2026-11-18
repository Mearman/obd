import {
  formatPlate,
  normalisePlate,
  normaliseVin,
  plateAt,
  type PlateAssignment,
  type Vehicle,
  type VehicleRegister,
} from "obd-read";
import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "../database/DatabaseProvider";
import { failureMessage } from "../diagnostics/client";
import { useDiagnostics } from "../diagnostics/DiagnosticsProvider";
import { error, muted, row, stack } from "../screens/screen.css";
import { Button, Card, DataTable, Dialog, Menu, Select, TextField, type Column } from "../ui";
import { DAY, dayInput, dayOfInput, vehicleName } from "./vehicle-text";

/** A plate's period as a list shows it: its first day and its last (the day before its exclusive end, or the day of an end within a day), either open. */
function periodText(assignment: PlateAssignment): string {
  const from = assignment.validFrom === null ? "an unknown date" : dayInput(assignment.validFrom);
  return assignment.validTo === null
    ? `from ${from}, still on it`
    : `from ${from} until ${dayInput(assignment.validTo - 1)}`;
}

/** The plates `vehicle` carried, newest first. */
function platesOf(register: VehicleRegister, vehicle: Vehicle): PlateAssignment[] {
  return register.plates
    .filter((assignment) => assignment.vehicleId === vehicle.id)
    .sort((a, b) => (b.validFrom ?? -Infinity) - (a.validFrom ?? -Infinity));
}

/** What the person is doing in the card's dialog, if anything. */
type Editing =
  | { readonly kind: "vehicle" }
  | { readonly kind: "plate"; readonly vehicle: Vehicle }
  | { readonly kind: "moved"; readonly vehicle: Vehicle; readonly assignment: PlateAssignment }
  | { readonly kind: "period"; readonly vehicle: Vehicle; readonly assignment: PlateAssignment }
  | { readonly kind: "label"; readonly vehicle: Vehicle }
  | { readonly kind: "merge"; readonly vehicle: Vehicle };

/** The dialog's title and description for what the person is doing. */
function dialogText(editing: Editing): { readonly title: string; readonly description: string } {
  switch (editing.kind) {
    case "vehicle":
      return {
        title: "Add a vehicle",
        description:
          "For a car whose units report no VIN, or one you want to name before reading it. Give its VIN if you know it, or the plate it carries, so its items can be found by that plate at their time.",
      };
    case "plate":
      return {
        title: `Add a plate to ${vehicleName(editing.vehicle)}`,
        description:
          "The plate is on this car from the day you give. Its open plate, if it began before then, ends that day; a car carries one plate at a time. Leave the day empty only for a car with no open plate.",
      };
    case "moved":
      return {
        title: `Plate ${formatPlate(editing.assignment.plate)} moved off`,
        description:
          "The last day the plate was on this car. From the next day it is free for another car.",
      };
    case "period":
      return {
        title: `Change ${formatPlate(editing.assignment.plate)} on ${vehicleName(editing.vehicle)}`,
        description:
          "The first and last day this car carried the plate; leave the first empty when it is not known and the last empty while it still carries it. A period may not overlap another of this plate or another plate of this car. Delete it if it was recorded by mistake.",
      };
    case "label":
      return {
        title: `Name ${vehicleName(editing.vehicle)}`,
        description: "A name for this car, shown beside its VIN and in the Library.",
      };
    case "merge":
      return {
        title: `Merge ${vehicleName(editing.vehicle)}`,
        description:
          "For two records that are one car: the other record's plates and name move to this one, and the other is removed. Two records with different VINs cannot merge.",
      };
  }
}

/**
 * Settings card: the vehicles this device has read or the person added, each with its VIN, its plate now and the plates it carried before, with dialogs to add a vehicle, add a plate from a date, mark a plate as moved off the car, change or delete a plate's period, name a vehicle and merge two records of one car. Nothing is looked up from a plate.
 */
export function VehiclesCard() {
  const { service } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const [register, setRegister] = useState<VehicleRegister | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [vin, setVin] = useState("");
  const [plate, setPlate] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");
  const [other, setOther] = useState("");
  // When the card was opened: what "Plate now" reads the register at, as plateAt does.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let current = true;
    client.vehicles.list().then(
      (found) => {
        if (current) setRegister(found);
      },
      (caught: unknown) => {
        if (current) setProblem(failureMessage(caught, "The vehicles could not be read."));
      },
    );
    return () => {
      current = false;
    };
  }, [client, revision]);

  const act = useCallback(async (work: () => Promise<VehicleRegister>, failure: string) => {
    setProblem(undefined);
    try {
      setRegister(await work());
      setEditing(undefined);
    } catch (caught) {
      setProblem(failureMessage(caught, failure));
    }
  }, []);

  const open = (next: Editing): void => {
    setProblem(undefined);
    setVin("");
    setPlate("");
    setLabel(next.kind === "vehicle" ? "" : next.vehicle.label);
    setOther("");
    if (next.kind === "period") {
      const { validFrom, validTo } = next.assignment;
      setFrom(validFrom === null ? "" : dayInput(validFrom));
      setTo(validTo === null ? "" : dayInput(validTo - 1));
    } else {
      setFrom("");
      setTo("");
    }
    setEditing(next);
  };

  const columns: readonly Column<Vehicle>[] =
    register === undefined
      ? []
      : [
          {
            header: "Name",
            render: (vehicle) =>
              vehicle.label === "" ? <span className={muted}>Not named</span> : vehicle.label,
          },
          { header: "VIN", render: (vehicle) => vehicle.vin ?? "Not known" },
          {
            header: "Plate now",
            nowrap: true,
            render: (vehicle) => {
              const current = plateAt(register, vehicle.id, now);
              return current === null ? "None" : formatPlate(current);
            },
          },
          {
            header: "Plates",
            render: (vehicle) => {
              const plates = platesOf(register, vehicle);
              return plates.length === 0 ? (
                <span className={muted}>None recorded</span>
              ) : (
                <ul className={stack} aria-label={`Plates of ${vehicleName(vehicle)}`}>
                  {plates.map((assignment) => (
                    <li key={assignment.id}>
                      {`${formatPlate(assignment.plate)} ${periodText(assignment)}`}
                    </li>
                  ))}
                </ul>
              );
            },
          },
          {
            header: "Actions",
            nowrap: true,
            render: (vehicle) => {
              const plates = platesOf(register, vehicle);
              const current = plates.find((each) => each.validTo === null);
              return (
                <Menu
                  label="Edit"
                  triggerLabel={`Edit ${vehicleName(vehicle)}`}
                  items={[
                    {
                      label: "Add a plate",
                      onSelect: () => {
                        open({ kind: "plate", vehicle });
                      },
                    },
                    ...(current === undefined
                      ? []
                      : [
                          {
                            label: `Plate ${formatPlate(current.plate)} moved off`,
                            onSelect: () => {
                              open({ kind: "moved", vehicle, assignment: current });
                            },
                          },
                        ]),
                    ...plates.map((assignment) => ({
                      label: `Change ${formatPlate(assignment.plate)} ${periodText(assignment)}`,
                      onSelect: () => {
                        open({ kind: "period", vehicle, assignment });
                      },
                    })),
                    {
                      label: "Name it",
                      onSelect: () => {
                        open({ kind: "label", vehicle });
                      },
                    },
                    ...(register.vehicles.length > 1
                      ? [
                          {
                            label: "Merge with another",
                            onSelect: () => {
                              open({ kind: "merge", vehicle });
                            },
                          },
                        ]
                      : []),
                  ]}
                />
              );
            },
          },
        ];

  const typed = normalisePlate(plate);
  const typedVin = normaliseVin(vin);
  const fromDay = dayOfInput(from);
  const toDay = dayOfInput(to);

  return (
    <Card
      title="Vehicles"
      description="Each car this device has read, by its VIN, or added here, and the number plates it carried. A plate you give a connection is recorded with what you save; a plate that moves to another car ends on the first one when the other is read with it. Nothing is looked up from a plate, and plates never go into a share link."
    >
      {problem !== undefined && editing === undefined && (
        <p role="alert" className={error}>
          {problem}
        </p>
      )}
      {register === undefined ? (
        <p className={muted}>Reading the vehicles…</p>
      ) : register.vehicles.length === 0 ? (
        <p className={muted}>
          No vehicles yet. A car is added when a scan reads its VIN on a connection; for a car whose
          units report no VIN, add it here with its plate.
        </p>
      ) : (
        <DataTable
          label="Vehicles"
          columns={columns}
          rows={register.vehicles}
          rowKey={(vehicle) => vehicle.id}
        />
      )}
      {register !== undefined && (
        <Button
          onClick={() => {
            open({ kind: "vehicle" });
          }}
        >
          Add a vehicle
        </Button>
      )}
      {editing !== undefined && register !== undefined && (
        <Dialog
          open
          onOpenChange={(opened) => {
            if (!opened) setEditing(undefined);
          }}
          {...dialogText(editing)}
        >
          <div className={stack}>
            {editing.kind === "vehicle" && (
              <>
                <TextField label="Name" value={label} onValueChange={setLabel} />
                <TextField label="VIN (optional)" value={vin} onValueChange={setVin} />
                <TextField label="Number plate" value={plate} onValueChange={setPlate} />
                <TextField
                  label="Plate on it from (UTC)"
                  type="date"
                  value={from}
                  onValueChange={setFrom}
                />
                <Button
                  disabled={typed === null && typedVin === null}
                  onClick={() => {
                    void act(
                      () =>
                        client.vehicles.addVehicle({
                          vin: typedVin,
                          label,
                          plate: typed,
                          validFrom: fromDay ?? null,
                        }),
                      "The vehicle could not be added.",
                    );
                  }}
                >
                  Add the vehicle
                </Button>
              </>
            )}
            {editing.kind === "plate" && (
              <>
                <TextField label="Number plate" value={plate} onValueChange={setPlate} />
                <TextField
                  label="On it from (UTC)"
                  type="date"
                  value={from}
                  onValueChange={setFrom}
                />
                <Button
                  disabled={typed === null}
                  onClick={() => {
                    if (typed === null) return;
                    void act(
                      () =>
                        client.vehicles.addPlate({
                          vehicleId: editing.vehicle.id,
                          plate: typed,
                          validFrom: fromDay ?? null,
                        }),
                      "The plate could not be added.",
                    );
                  }}
                >
                  Add the plate
                </Button>
              </>
            )}
            {editing.kind === "moved" && (
              <>
                <TextField
                  label="Last day on this car (UTC)"
                  type="date"
                  value={from}
                  onValueChange={setFrom}
                />
                <Button
                  disabled={fromDay === undefined}
                  onClick={() => {
                    if (fromDay === undefined) return;
                    void act(
                      () =>
                        client.vehicles.savePlate({
                          ...editing.assignment,
                          validTo: fromDay + DAY,
                        }),
                      "The plate could not be ended.",
                    );
                  }}
                >
                  End the plate
                </Button>
              </>
            )}
            {editing.kind === "period" && (
              <>
                <TextField
                  label="First day on this car (UTC)"
                  type="date"
                  value={from}
                  onValueChange={setFrom}
                />
                <TextField
                  label="Last day on this car (UTC)"
                  type="date"
                  value={to}
                  onValueChange={setTo}
                />
                <div className={row}>
                  <Button
                    onClick={() => {
                      void act(
                        () =>
                          client.vehicles.savePlate({
                            ...editing.assignment,
                            validFrom: fromDay ?? null,
                            validTo: toDay === undefined ? null : toDay + DAY,
                          }),
                        "The plate's period could not be changed.",
                      );
                    }}
                  >
                    Keep the period
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void act(
                        () => client.vehicles.deletePlate({ id: editing.assignment.id }),
                        "The plate could not be deleted.",
                      );
                    }}
                  >
                    Delete this plate
                  </Button>
                </div>
              </>
            )}
            {editing.kind === "label" && (
              <>
                <TextField label="Name" value={label} onValueChange={setLabel} />
                <Button
                  onClick={() =>
                    void act(
                      () => client.vehicles.save({ ...editing.vehicle, label: label.trim() }),
                      "The name could not be kept.",
                    )
                  }
                >
                  Keep the name
                </Button>
              </>
            )}
            {editing.kind === "merge" && (
              <>
                <Select
                  label="The same car as"
                  value={other === "" ? "none" : other}
                  options={[
                    { value: "none", label: "Choose a vehicle" },
                    ...register.vehicles
                      .filter((vehicle) => vehicle.id !== editing.vehicle.id)
                      .map((vehicle) => ({ value: vehicle.id, label: vehicleName(vehicle) })),
                  ]}
                  onValueChange={(value) => {
                    setOther(value === "none" ? "" : value);
                  }}
                />
                <Button
                  disabled={other === ""}
                  onClick={() =>
                    void act(
                      () => client.vehicles.merge({ keep: editing.vehicle.id, remove: other }),
                      "The vehicles could not be merged.",
                    )
                  }
                >
                  Merge into this one
                </Button>
              </>
            )}
            {problem !== undefined && (
              <p role="alert" className={error}>
                {problem}
              </p>
            )}
            <div className={row}>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(undefined);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}
