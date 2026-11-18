import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VehicleRegister } from "obd-read";
import { describe, expect, it } from "vitest";
import { VehiclesCard } from "../src/vehicles/VehiclesCard";
import { createTestService, renderApp, type TestService } from "./render";

const ESTATE_VIN = "WDB2110200A000001";
const HATCH_VIN = "WDB2110200A000002";
const FIRST = "AB12 CDE";
const SECOND = "XY65 ZZZ";
const DAY = 86_400_000;
const START_2015 = Date.UTC(2015, 0, 1);
const START_2020 = Date.UTC(2020, 0, 1);

/** The register read back through the client the card uses. */
function register(service: TestService): Promise<VehicleRegister> {
  return service.client.vehicles.list();
}

/** A car with a VIN carrying {@link FIRST} from 2020, and a car known only by {@link SECOND}, which it carried until the end of 2019. */
async function twoRecordsOfOneCar(service: TestService): Promise<void> {
  await service.client.vehicles.addVehicle({
    vin: ESTATE_VIN,
    label: "",
    plate: FIRST,
    validFrom: START_2020,
  });
  const added = await service.client.vehicles.addVehicle({
    vin: null,
    label: "Blue estate",
    plate: SECOND,
    validFrom: START_2015,
  });
  const assignment = added.plates.find((each) => each.plate === "XY65ZZZ");
  if (assignment === undefined) throw new Error("expected the added plate");
  await service.client.vehicles.savePlate({ ...assignment, validTo: START_2020 });
}

/** Opens the card's dialog to merge the record named `from` with another. */
async function openMerge(from: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${from}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Merge with another" }));
}

describe("the Vehicles card merge", () => {
  it("merges two records of one car into one holding both plates and their periods", async () => {
    const service = createTestService();
    await twoRecordsOfOneCar(service);
    await renderApp(<VehiclesCard />, service);
    const table = await screen.findByRole("table", { name: "Vehicles" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);

    await openMerge(ESTATE_VIN);
    const dialog = await screen.findByRole("dialog", { name: `Merge ${ESTATE_VIN}` });
    expect(within(dialog).getByRole("button", { name: "Merge into this one" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("combobox", { name: "The same car as" }));
    await userEvent.click(await screen.findByRole("option", { name: "Blue estate" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge into this one" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    const plates = screen.getByRole("list", { name: `Plates of Blue estate (${ESTATE_VIN})` });
    expect(
      within(plates)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      `${FIRST} from 2020-01-01, still on it`,
      `${SECOND} from 2015-01-01 until ${new Date(START_2020 - DAY).toISOString().slice(0, 10)}`,
    ]);
    expect(screen.queryByRole("list", { name: "Plates of Blue estate" })).toBeNull();

    const kept = await register(service);
    expect(kept.vehicles).toHaveLength(1);
    expect(kept.plates).toHaveLength(2);
  });

  it("refuses to merge two records with different VINs and changes nothing", async () => {
    const service = createTestService();
    await service.client.vehicles.addVehicle({
      vin: ESTATE_VIN,
      label: "",
      plate: FIRST,
      validFrom: START_2020,
    });
    await service.client.vehicles.addVehicle({
      vin: HATCH_VIN,
      label: "",
      plate: SECOND,
      validFrom: START_2015,
    });
    const before = await register(service);
    await renderApp(<VehiclesCard />, service);
    const table = await screen.findByRole("table", { name: "Vehicles" });

    await openMerge(ESTATE_VIN);
    const dialog = await screen.findByRole("dialog", { name: `Merge ${ESTATE_VIN}` });
    await userEvent.click(within(dialog).getByRole("combobox", { name: "The same car as" }));
    await userEvent.click(await screen.findByRole("option", { name: HATCH_VIN }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge into this one" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/different VINs/);
    expect(screen.getByRole("dialog", { name: `Merge ${ESTATE_VIN}` })).toBeVisible();
    // The open dialog hides the card from the accessibility tree.
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(3);
    expect(await register(service)).toEqual(before);
  });
});
