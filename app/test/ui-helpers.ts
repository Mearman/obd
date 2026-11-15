import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Opens the vehicle profile picker on the Connect screen and chooses the profile with this name. */
export async function pickProfile(name: string): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: /Vehicle profile/ }));
  const options = await screen.findAllByRole("option");
  const found = options.find((option) => option.dataset.profile === name);
  if (found === undefined) throw new Error(`no profile option ${name}`);
  await userEvent.click(found);
}
