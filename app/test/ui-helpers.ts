import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Opens a profile picker by its label and chooses the profile with this name; an empty name is Generic OBD-II. */
export async function pickProfile(name: string, label = "Vehicle profile"): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
  const options = await screen.findAllByRole("option");
  const found = options.find((option) => option.dataset.profile === name);
  if (found === undefined) throw new Error(`no profile option ${name}`);
  await userEvent.click(found);
}

/** A section of the Session screen, by its title in the section navigation. */
export type SessionSection = "Connection" | "Read" | "Live" | "Advanced";

/** Shows the Session screen and expands one of its sections, leaving it expanded if it already is. */
export async function openSection(name: SessionSection): Promise<void> {
  const tab = screen.getByRole("tab", { name: "Session" });
  if (tab.getAttribute("aria-selected") !== "true") await userEvent.click(tab);
  const nav = screen.getByRole("navigation", { name: "Session sections" });
  const button = within(nav).getByRole("button", { name });
  if (button.getAttribute("aria-expanded") !== "true") await userEvent.click(button);
}
