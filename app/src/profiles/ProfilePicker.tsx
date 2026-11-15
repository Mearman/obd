import * as RadixDialog from "@radix-ui/react-dialog";
import { useId, useMemo, useState } from "react";
import { Badge, Button } from "../ui";
import { grouped, importedEntry, matches, shippedEntry, type CatalogueEntry } from "./catalogue";
import { GENERIC_SUMMARY, GENERIC_TITLE } from "./generic";
import {
  badges,
  empty,
  field,
  fieldLabel,
  groupLabel,
  heading,
  list,
  option,
  overlay,
  panel,
  primary,
  search,
  secondary,
  stack,
  trigger,
} from "./ProfilePicker.css";

/** Props of {@link ProfilePicker}. */
export interface ProfilePickerProps {
  /** Names of the shipped profiles. */
  readonly builtin: readonly string[];
  /** Names of the imported profiles. */
  readonly imported: readonly string[];
  /** The chosen profile's name, or `undefined` for generic OBD-II. */
  readonly value: string | undefined;
  readonly onValueChange: (name: string | undefined) => void;
  readonly disabled?: boolean;
  /** What the control is called: its label, its accessible name and the dialog's title. */
  readonly label?: string;
}

function units(entry: CatalogueEntry): string {
  return entry.units === 1 ? "1 unit" : `${String(entry.units)} units`;
}

/**
 * A vehicle chooser: the chosen vehicle's name and coverage on the trigger, and a searchable list grouped by make in a dialog. Generic OBD-II is always the first row.
 */
export function ProfilePicker({
  builtin,
  imported,
  value,
  onValueChange,
  disabled,
  label = "Vehicle profile",
}: ProfilePickerProps) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const entries = useMemo(
    () => [
      ...builtin.map(shippedEntry),
      ...imported.filter((name) => !builtin.includes(name)).map(importedEntry),
    ],
    [builtin, imported],
  );
  const groups = useMemo(
    () => grouped(entries.filter((entry) => matches(entry, query))),
    [entries, query],
  );
  const current = value === undefined ? undefined : entries.find((entry) => entry.name === value);
  const showGeneric = matches(
    {
      name: "generic",
      group: "",
      title: GENERIC_TITLE,
      detail: GENERIC_SUMMARY,
      units: 0,
      status: "",
      imported: false,
    },
    query,
  );

  const choose = (name: string | undefined) => {
    onValueChange(name);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className={field}>
      <span id={labelId} className={fieldLabel}>
        {label}
      </span>
      <RadixDialog.Root open={open} onOpenChange={setOpen}>
        <RadixDialog.Trigger asChild>
          <button
            type="button"
            className={trigger}
            aria-labelledby={labelId}
            disabled={disabled === true}
          >
            <span className={stack}>
              <span className={primary}>{current?.title ?? value ?? GENERIC_TITLE}</span>
              <span className={secondary}>
                {current === undefined
                  ? "Any compliant car, no control units"
                  : current.detail || current.name}
              </span>
            </span>
            <span aria-hidden>▾</span>
          </button>
        </RadixDialog.Trigger>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className={overlay} />
          <RadixDialog.Content className={panel} aria-describedby={undefined}>
            <RadixDialog.Title className={heading}>{label}</RadixDialog.Title>
            <input
              type="search"
              className={search}
              value={query}
              placeholder="Search make, model or chassis"
              aria-label="Search profiles"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            <div className={list} role="listbox" aria-label={label}>
              {showGeneric && (
                <button
                  type="button"
                  role="option"
                  aria-selected={value === undefined}
                  className={option}
                  data-profile=""
                  onClick={() => {
                    choose(undefined);
                  }}
                >
                  <span className={stack}>
                    <span className={primary}>{GENERIC_TITLE}</span>
                    <span className={secondary}>Any compliant car, no control units</span>
                  </span>
                </button>
              )}
              {groups.map(({ group, entries: members }) => (
                <div key={group} role="group" aria-label={group}>
                  <div className={groupLabel}>{group}</div>
                  {members.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      role="option"
                      aria-selected={entry.name === value}
                      className={option}
                      data-profile={entry.name}
                      onClick={() => {
                        choose(entry.name);
                      }}
                    >
                      <span className={stack}>
                        <span className={primary}>{entry.title}</span>
                        <span className={secondary}>{entry.detail || entry.name}</span>
                        {!entry.imported && (
                          <span className={badges}>
                            <Badge>{units(entry)}</Badge>
                            <Badge tone="warning">{entry.status}</Badge>
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {!showGeneric && groups.length === 0 && (
                <p className={empty}>No profile matches “{query}”. Import one in Settings.</p>
              )}
            </div>
            <RadixDialog.Close asChild>
              <Button>Cancel</Button>
            </RadixDialog.Close>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    </div>
  );
}
