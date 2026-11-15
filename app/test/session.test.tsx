import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { BrowserSupport } from "../src/connect/support";
import { setWideLayout } from "./media";
import { createTestService, renderApp } from "./render";
import { openSection, pickProfile, type SessionSection } from "./ui-helpers";

const CHROME: BrowserSupport = {
  family: "chromium",
  capabilities: {
    webSerial: true,
    webBluetooth: true,
    webUsb: true,
    secureContext: true,
    usable: true,
    issues: [],
  },
};

function navButton(name: SessionSection): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "Session sections" });
  return within(nav).getByRole("button", { name });
}

/** The section the navigation button controls, found by id so a collapsed section is found too. */
function section(name: SessionSection): HTMLElement {
  const id = navButton(name).getAttribute("aria-controls");
  const element = id === null ? null : document.getElementById(id);
  if (element === null) throw new Error(`no ${name} section`);
  return element;
}

function expanded(): SessionSection[] {
  return (["Connection", "Read", "Live", "Advanced"] as const).filter(
    (name) => navButton(name).getAttribute("aria-expanded") === "true",
  );
}

async function connectSimulator(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /connect with the simulator/i }));
  await screen.findByText("Connected to Simulator");
}

describe("the Session screen's tab bar", () => {
  it("has Session, Library, Guide and Settings, opening on Session", () => {
    renderApp(<App support={CHROME} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Session",
      "Library",
      "Guide",
      "Settings",
    ]);
    expect(screen.getByRole("tab", { name: "Session" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Session", level: 1 })).toBeVisible();
  });
});

describe("the section navigation", () => {
  it("on a narrow screen shows one section at a time, each controlling its section", async () => {
    renderApp(<App support={CHROME} />);
    expect(expanded()).toEqual(["Connection"]);
    for (const name of ["Read", "Live", "Advanced", "Connection"] as const) {
      await userEvent.click(navButton(name));
      expect(expanded()).toEqual([name]);
      expect(section(name)).toBeVisible();
      expect(section(name)).toHaveAccessibleName(name);
      for (const other of ["Connection", "Read", "Live", "Advanced"] as const) {
        if (other !== name) expect(section(other)).not.toBeVisible();
      }
    }
  });

  it("on a wide screen shows Read and Live together and toggles each section on its own", async () => {
    setWideLayout(true);
    renderApp(<App support={CHROME} />);
    expect(expanded()).toEqual(["Connection", "Read", "Live"]);
    await userEvent.click(navButton("Advanced"));
    expect(expanded()).toEqual(["Connection", "Read", "Live", "Advanced"]);
    await userEvent.click(navButton("Read"));
    expect(expanded()).toEqual(["Connection", "Live", "Advanced"]);
    expect(section("Read")).not.toBeVisible();
    expect(section("Live")).toBeVisible();
  });

  it("follows the connection: Connection until connected, then Read, and Connection again after Disconnect", async () => {
    renderApp(<App support={CHROME} />);
    expect(expanded()).toEqual(["Connection"]);
    await connectSimulator();
    expect(expanded()).toEqual(["Read"]);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => {
      expect(expanded()).toEqual(["Connection"]);
    });
    expect(screen.getByText("Not connected", { selector: "p" })).toBeVisible();
  });
});

describe("sections that need a connection", () => {
  it.each([
    ["Read", /Connect first: scanning and capturing needs an adapter/, "Start scan"],
    ["Live", /Connect first: collecting live values needs an adapter/, "Start collecting"],
    [
      "Advanced",
      /Connect first: changing the car needs an adapter/,
      "Clear every emissions code (mode 04)",
    ],
  ] as const)("%s says why it is disabled and opens Connection", async (name, reason, action) => {
    renderApp(<App support={CHROME} />);
    await openSection(name);
    const area = section(name);
    expect(within(area).getByRole("note")).toHaveTextContent(reason);
    expect(within(area).getByRole("button", { name: action })).toBeDisabled();
    await userEvent.click(within(area).getByRole("button", { name: "Open Connection" }));
    expect(expanded()).toEqual(["Connection"]);
    expect(screen.getByRole("button", { name: /connect with the simulator/i })).toBeVisible();
  });

  it("drops the Connect first note once connected", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    for (const name of ["Read", "Live", "Advanced"] as const) {
      await openSection(name);
      expect(within(section(name)).queryByRole("note")).toBeNull();
    }
    expect(
      screen.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
    ).toBeEnabled();
  });

  it("says a collection run holds the adapter in Read and Advanced, and where to stop it", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    await openSection("Live");
    await userEvent.click(await screen.findByRole("button", { name: "Start collecting" }));
    await screen.findByText("engine speed");
    for (const name of ["Read", "Advanced"] as const) {
      await openSection(name);
      expect(section(name)).toHaveTextContent(
        "A collection run holds the adapter. Stop it in the Live section.",
      );
    }
    expect(
      screen.getByRole("button", { name: "Clear every emissions code (mode 04)" }),
    ).toBeDisabled();
    await openSection("Live");
    await userEvent.click(screen.getByRole("button", { name: "Stop collecting" }));
  });
});

describe("the connection summary", () => {
  it("collapses Connection to one line with the adapter, profile, battery voltage and Disconnect", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await pickProfile("mercedes-w211");
    await connectSimulator();
    const status = await service.client.link.status();
    const voltage = status?.info.voltage;
    if (voltage === null || voltage === undefined)
      throw new Error("the simulator reports a voltage");
    const line = screen.getByText("Connected to Simulator").closest("p");
    if (line === null) throw new Error("no summary line");
    expect(line).toHaveTextContent(
      `Connected to SimulatorProfile: mercedes-w211Battery ${voltage}`,
    );
    expect(section("Connection")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();

    await openSection("Connection");
    expect(within(section("Connection")).getByText(status?.info.identity ?? "")).toBeVisible();
    expect(screen.queryByRole("button", { name: /connect with the simulator/i })).toBeNull();
  });

  it("disconnects from the summary", async () => {
    const service = createTestService();
    renderApp(<App support={CHROME} />, service);
    await connectSimulator();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(
      await screen.findByRole("button", { name: /connect with the simulator/i }),
    ).toBeVisible();
    expect(await service.client.link.status()).toBeNull();
  });
});

describe("the Advanced section", () => {
  it("starts collapsed, with its operations hidden", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    expect(navButton("Advanced")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "Write a value" })).toBeNull();
  });

  it("keeps every typed field through collapsing and expanding, and through another screen", async () => {
    renderApp(<App support={CHROME} />);
    await openSection("Advanced");
    const typed = {
      "Unit to change": "transmission",
      "Write request (hexadecimal)": "3B 99 00 02",
      "Read request for the same value": "21 99",
      "Actuator start request (hexadecimal)": "30 20 07 01",
      "Actuator stop request (hexadecimal)": "30 20 00",
      "Hold for (milliseconds, at most 30000)": "2500",
    } as const;
    for (const [label, value] of Object.entries(typed)) {
      const input = screen.getByLabelText(label);
      await userEvent.clear(input);
      await userEvent.type(input, value);
    }

    await openSection("Read");
    expect(navButton("Advanced")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Write request (hexadecimal)")).not.toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await openSection("Advanced");
    for (const [label, value] of Object.entries(typed)) {
      expect(screen.getByLabelText(label)).toHaveValue(value);
    }
  });
});

describe("the Session screen's handoffs", () => {
  it("keeps a scan's results while the Library is shown", async () => {
    renderApp(<App support={CHROME} />);
    await connectSimulator();
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    await screen.findByRole("table", { name: /Scan of Generic OBD-II/ });
    await userEvent.click(screen.getByRole("tab", { name: "Library" }));
    await userEvent.click(screen.getByRole("tab", { name: "Session" }));
    expect(screen.getByRole("table", { name: /Scan of Generic OBD-II/ })).toBeVisible();
  });
});
