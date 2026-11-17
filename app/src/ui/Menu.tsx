import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "./Button";
import { content, item } from "./Menu.css";

/** One entry of a {@link Menu}. */
export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}

/** Props of {@link Menu}. */
export interface MenuProps {
  /** The trigger's text, also the menu's accessible name. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  /** Names the trigger for a screen reader when several rows each have the same menu. */
  readonly triggerLabel?: string;
}

/** A button that opens a short list of related actions with 44 px rows, built on Radix so it works by keyboard too. */
export function Menu({ label, items, triggerLabel }: MenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>
        <Button aria-label={triggerLabel ?? label}>
          {label}
          <span aria-hidden> ▾</span>
        </Button>
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content className={content} align="end" sideOffset={4}>
          {items.map((entry) => (
            <RadixMenu.Item key={entry.label} className={item} onSelect={entry.onSelect}>
              {entry.label}
            </RadixMenu.Item>
          ))}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
