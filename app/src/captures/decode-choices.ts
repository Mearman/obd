import { useMemo } from "react";
import { GENERIC_TITLE } from "../profiles/generic";
import { useProfiles } from "../profiles/ProfilesProvider";
import type { SelectOption } from "../ui";

/** The decode selector's value for decoding with no profile. */
export const GENERIC_CHOICE = "";

/** The profile a choice names, or `null` for Generic. */
export function chosenProfile(choice: string): string | null {
  return choice === GENERIC_CHOICE ? null : choice;
}

/** What a capture can be decoded with: Generic, every shipped profile, then every imported one that does not share a shipped name. */
export function useDecodeChoices(): readonly SelectOption[] {
  const { builtin, imported } = useProfiles();
  return useMemo(
    () => [
      { value: GENERIC_CHOICE, label: GENERIC_TITLE },
      ...builtin.map((name) => ({ value: name, label: name })),
      ...imported
        .filter((name) => !builtin.includes(name))
        .map((name) => ({ value: name, label: `${name} (imported)` })),
    ],
    [builtin, imported],
  );
}
