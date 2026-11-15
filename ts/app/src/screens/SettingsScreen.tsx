import { useId, useRef, useState, type ChangeEvent } from "react";
import { useProfiles, type ImportResult } from "../profiles/ProfilesProvider";
import { isThemePreference } from "../theme/preference";
import { useTheme } from "../theme/ThemeProvider";
import { Button, Card, Select } from "../ui";
import { error, list, muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

const THEME_OPTIONS = [
  { value: "system", label: "Follow the device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Settings: colour scheme and profile import from a local JSON file. */
export function SettingsScreen() {
  const { preference, setPreference } = useTheme();
  const { builtin, imported, importText } = useProfiles();
  const [result, setResult] = useState<ImportResult | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    setResult(importText(await file.text(), file.name));
  }

  return (
    <div className={page}>
      <ScreenHeading>Settings</ScreenHeading>
      <Card title="Appearance">
        <Select
          label="Colour scheme"
          value={preference}
          options={THEME_OPTIONS}
          onValueChange={(value) => {
            if (isThemePreference(value)) setPreference(value);
          }}
        />
      </Card>
      <Card
        title="Vehicle profiles"
        description="Profiles are JSON files. Importing checks the file against the same schema as the bundled ones, and nothing leaves this device. Imported profiles last until the page closes."
      >
        <p>
          Bundled: {builtin.join(", ")}.
          {imported.size > 0 && ` Imported: ${[...imported.keys()].join(", ")}.`}
        </p>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Profile file"
          onChange={(event) => void onFile(event)}
        />
        <Button block onClick={() => input.current?.click()} aria-describedby={statusId}>
          Import a profile file
        </Button>
        <div id={statusId} role="status">
          {result?.ok === true && <p>Imported profile {result.name}.</p>}
          {result?.ok === false && (
            <div className={error}>
              <p>That file is not a valid profile:</p>
              <ul className={list}>
                {result.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Card>
      <Card title="About collection">
        <p className={muted}>
          Collection runs while the app is open. With the screen off or the app closed, Android may
          suspend it.
        </p>
      </Card>
    </div>
  );
}
