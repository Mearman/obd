import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Opens a profile picker by its label and chooses the profile with this name; an empty name is Generic OBD-II. */
export async function pickProfile(name: string, label = "Vehicle profile"): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
  const options = await screen.findAllByRole("option");
  const found = options.find((option) => option.dataset.profile === name);
  if (found === undefined) throw new Error(`no profile option ${name}`);
  await userEvent.click(found);
}
