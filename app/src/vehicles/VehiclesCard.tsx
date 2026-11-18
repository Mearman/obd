import {
  formatPlate,
  normalisePlate,
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

/** A plate's period as a list shows it: its first day and its last, either open. */
function periodText(assignment: PlateAssignment): string {
  const from = assignment.validFrom === null ? "an unknown date" : dayInput(assignment.validFrom);
  return assignment.validTo === null
    ? `from ${from}, still on it`
    : `from ${from} until ${dayInput(assignment.validTo)}`;
}

/** The plates `vehicle` carried, newest first. */
function platesOf(register: VehicleRegister, vehicle: Vehicle): PlateAssignment[] {
  return register.plates
    .filter((assignment) => assignment.vehicleId === vehicle.id)
    .sort((a, b) => (b.validFrom ?? -Infinity) - (a.validFrom ?? -Infinity));
}

/** What the person is doing in the card's dialog, if anything. */
type Editing =
  | { readonly kind: "plate"; readonly vehicle: Vehicle }
  | { readonly kind: "moved"; readonly vehicle: Vehicle; readonly assignment: PlateAssignment }
  | { readonly kind: "label"; readonly vehicle: Vehicle }
  | { readonly kind: "merge"; readonly vehicle: Vehicle };

/**
 * Settings card: the vehicles this device has read, each with its VIN, its plate now and the plates it carried before, with dialogs to add a plate from a date, mark a plate as moved off the car, name a vehicle and merge two records of one car. Nothing is looked up from a plate.
 */
export function VehiclesCard() {
  const { service } = useDiagnostics();
  const { client } = service;
  const { revision } = useDatabase();
  const [register, setRegister] = useState<VehicleRegister | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const [plate, setPlate] = useState("");
  const [from, setFrom] = useState("");
  const [label, setLabel] = useState("");
  const [other, setOther] = useState("");

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
    setPlate("");
    setFrom("");
    setLabel(next.vehicle.label);
    setOther("");
    setEditing(next);
  };

  const columns: readonly Column<Vehicle>[] =
    register === undefined
      ? []
      : [
          { header: "Vehicle", render: (vehicle) => vehicleName(vehicle) },
          { header: "VIN", render: (vehicle) => vehicle.vin ?? "Not known" },
          {
            header: "Plate now",
            nowrap: true,
            render: (vehicle) => {
              // The plate it carries now is the one whose period is still open.
              const current =
                platesOf(register, vehicle).find((each) => each.validTo === null)?.plate ?? null;
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
              const current = platesOf(register, vehicle).find((each) => each.validTo === null);
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
  const fromDay = dayOfInput(from);

  return (
    <Card
      title="Vehicles"
      description="Each car this device has read, by its VIN, and the number plates it carried. A plate you give a connection is recorded with what you save; a plate that moves to another car ends on the first one when the other is read with it. Nothing is looked up from a plate, and plates never go into a share link."
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
          No vehicles yet. A car is added when a scan reads its VIN on a connection.
        </p>
      ) : (
        <DataTable
          label="Vehicles"
          columns={columns}
          rows={register.vehicles}
          rowKey={(vehicle) => vehicle.id}
        />
      )}
      {editing !== undefined && register !== undefined && (
        <Dialog
          open
          onOpenChange={(opened) => {
            if (!opened) setEditing(undefined);
          }}
          title={
            editing.kind === "plate"
              ? `Add a plate to ${vehicleName(editing.vehicle)}`
              : editing.kind === "moved"
                ? `Plate ${formatPlate(editing.assignment.plate)} moved off`
                : editing.kind === "label"
                  ? `Name ${vehicleName(editing.vehicle)}`
                  : `Merge ${vehicleName(editing.vehicle)}`
          }
          description={
            editing.kind === "plate"
              ? "The plate is on this car from the day you give, or from an unknown date. Its plate before then, if still open, ends that day."
              : editing.kind === "moved"
                ? "The last day the plate was on this car. From the next day it is free for another car."
                : editing.kind === "label"
                  ? "A name for this car, shown beside its VIN."
                  : "For two records that are one car: the other record's plates and name move to this one, and the other is removed. Two records with different VINs cannot merge."
          }
        >
          <div className={stack}>
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
                    const start = fromDay ?? null;
                    const open = platesOf(register, editing.vehicle).find(
                      (each) =>
                        each.validTo === null &&
                        (start === null || (each.validFrom ?? -Infinity) < start),
                    );
                    void act(async () => {
                      if (open !== undefined && start !== null) {
                        await client.vehicles.savePlate({ ...open, validTo: start });
                      }
                      return client.vehicles.savePlate({
                        id: globalThis.crypto.randomUUID(),
                        vehicleId: editing.vehicle.id,
                        plate: typed,
                        validFrom: start,
                        validTo: null,
                      });
                    }, "The plate could not be added.");
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
