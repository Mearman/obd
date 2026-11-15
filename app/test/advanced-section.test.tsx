import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdvancedSection } from "../src/screens/scan/AdvancedSection";
import { renderApp } from "./render";

describe("the Advanced section", () => {
  it("starts collapsed, with its operations hidden", () => {
    renderApp(<AdvancedSection />);
    expect(screen.getByRole("button", { name: /^Advanced/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("button", { name: "Write a value" })).toBeNull();
  });

  it("keeps every typed field through collapsing and expanding", async () => {
    renderApp(<AdvancedSection />);
    const toggle = screen.getByRole("button", { name: /^Advanced/ });
    await userEvent.click(toggle);
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

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("Write request (hexadecimal)")).not.toBeVisible();

    await userEvent.click(toggle);
    for (const [label, value] of Object.entries(typed)) {
      expect(screen.getByLabelText(label)).toHaveValue(value);
    }
  });
});
