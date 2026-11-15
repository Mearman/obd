import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { actions, content, description, overlay, title } from "./Dialog.css";

/** Props of {@link Dialog}. */
export interface DialogProps {
  /** The element that opens the dialog; it must accept a ref and press events. */
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}

/**
 * A modal dialog with a title, a description and a Close button. Focus is trapped while open and
 * returns to the trigger on close; Escape closes it.
 */
export function Dialog({ trigger, title: heading, description: summary, children }: DialogProps) {
  return (
    <RadixDialog.Root>
      <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlay} />
        <RadixDialog.Content className={content}>
          <RadixDialog.Title className={title}>{heading}</RadixDialog.Title>
          <RadixDialog.Description className={description}>{summary}</RadixDialog.Description>
          {children}
          <div className={actions}>
            <RadixDialog.Close asChild>
              <Button variant="primary">Close</Button>
            </RadixDialog.Close>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
