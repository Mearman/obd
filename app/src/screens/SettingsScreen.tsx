import { useId, useRef, useState, type ChangeEvent } from "react";
import { DatabaseCard } from "../database/DatabaseCard";
import { useProfiles, type ImportResult } from "../profiles/ProfilesProvider";
import { UpdateCard } from "../pwa/UpdateCard";
import { useAutoSaveShared } from "../settings/auto-save-shared";
import { isThemePreference } from "../theme/preference";
import { useTheme } from "../theme/ThemeProvider";
import { Button, Card, Select, Switch } from "../ui";
import { COLLECTION_LIMIT } from "./limits";
import { disclosure, error, list, muted, page } from "./screen.css";
import { ScreenHeading } from "./ScreenHeading";

const THEME_OPTIONS = [
  { value: "system", label: "Follow the device" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Settings: colour scheme and profile import from a local JSON file. */
export function SettingsScreen() {
  const { preference, setPreference } = useTheme();
  const [autoSaveShared, setAutoSaveShared] = useAutoSaveShared();
  const { builtin, imported, importText } = useProfiles();
  const [result, setResult] = useState<ImportResult | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();

  async function onFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    setResult(await importText(await file.text()));
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
        title="Shared links"
        description="A link that someone sends you opens as a read-only copy. By default it is also saved to this device as soon as it has opened, marked as shared. This choice is kept in this browser only."
      >
        <Switch
          label="Save received links automatically"
          checked={autoSaveShared}
          onCheckedChange={setAutoSaveShared}
        />
      </Card>
      <Card
        title="Vehicle profiles"
        description="Profiles are JSON files. Importing checks the file against the same schema as the bundled ones, and nothing leaves this device. Imported profiles are kept on this device."
      >
        <details className={disclosure}>
          <summary>{`${String(builtin.length)} bundled profiles`}</summary>
          <p>{builtin.join(", ")}.</p>
        </details>
        {imported.length > 0 && <p>{`Imported: ${imported.join(", ")}.`}</p>}
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
      <DatabaseCard />
      <UpdateCard />
      <Card title="About collection">
        <p className={muted}>{COLLECTION_LIMIT}</p>
      </Card>
    </div>
  );
}
