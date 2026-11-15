import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { UpdatePrompt } from "../src/pwa/UpdatePrompt";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  Select,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToastProvider,
} from "../src/ui";

function ignore(): void {
  // The test does not look at this callback.
}

describe("components", () => {
  it("Button defaults to type button and fires clicks", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("Card and Badge show their text", () => {
    render(
      <Card title="Title" description="About it">
        <Badge tone="simulated">Simulated data</Badge>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("About it")).toBeInTheDocument();
    expect(screen.getByText("Simulated data")).toBeInTheDocument();
  });

  it("Tabs switch panels", async () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">One</TabsTrigger>
          <TabsTrigger value="b">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel one</TabsContent>
        <TabsContent value="b">Panel two</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText("Panel one")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Two" }));
    expect(screen.getByText("Panel two")).toBeInTheDocument();
  });

  it("Switch reports changes through its label", async () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Verbose" checked={on} onCheckedChange={setOn} />;
    }
    render(<Harness />);
    const control = screen.getByRole("switch", { name: "Verbose" });
    expect(control).not.toBeChecked();
    await userEvent.click(control);
    expect(control).toBeChecked();
  });

  it("Select picks an option", async () => {
    const onValueChange = vi.fn();
    render(
      <Select
        label="Profile"
        value="a"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onValueChange={onValueChange}
      />,
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Profile" }));
    await userEvent.click(await screen.findByRole("option", { name: "Beta" }));
    expect(onValueChange).toHaveBeenCalledWith("b");
  });

  it("Dialog opens with its title and closes", async () => {
    render(
      <Dialog trigger={<Button>Help</Button>} title="Help title" description="Help text">
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(await screen.findByRole("dialog", { name: "Help title" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("DataTable renders one row per item with each header as the cell label", () => {
    render(
      <DataTable
        label="Things"
        columns={[
          { header: "Name", render: (row: { n: string; v: number }) => row.n },
          { header: "Value", render: (row) => String(row.v) },
        ]}
        rows={[
          { n: "a", v: 1 },
          { n: "b", v: 2 },
        ]}
        rowKey={(row) => row.n}
      />,
    );
    expect(screen.getByRole("table", { name: "Things" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("2").closest("[role=cell]")).toHaveAttribute("data-label", "Value");
  });
});

describe("UpdatePrompt", () => {
  it("offers a reload when an update is ready", async () => {
    const onUpdate = vi.fn();
    render(
      <ToastProvider>
        <UpdatePrompt updateReady onDismiss={ignore} onUpdate={onUpdate} />
      </ToastProvider>,
    );
    expect(await screen.findByText("A new version is ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("shows nothing while no update is waiting", () => {
    render(
      <ToastProvider>
        <UpdatePrompt updateReady={false} onDismiss={ignore} onUpdate={ignore} />
      </ToastProvider>,
    );
    expect(screen.queryByText("A new version is ready")).not.toBeInTheDocument();
  });
});
