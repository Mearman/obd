import * as RadixToast from "@radix-ui/react-toast";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Button } from "./Button";
import { actions, description, root, title, viewport } from "./Toast.css";

/** An action button of a {@link Toast}. */
export interface ToastAction {
  readonly label: string;
  readonly onSelect: () => void;
}

/** Props of {@link Toast}. */
export interface ToastProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  /** Action buttons; each is at least 44 px high. Omit for a plain notice. */
  readonly actions?: readonly ToastAction[];
  /** Milliseconds before it closes itself; `Infinity` keeps it until dismissed. */
  readonly duration?: number;
  readonly children?: ReactNode;
}

/** Hosts toasts and their viewport. Place it once, around the app. */
export function ToastProvider({ children }: { readonly children: ReactNode }) {
  return (
    <RadixToast.Provider label="Notifications" swipeDirection="down">
      {children}
      <RadixToast.Viewport className={viewport} />
    </RadixToast.Provider>
  );
}

/** A notification with optional actions. Controlled: the caller owns `open`. */
export function Toast({
  open,
  onOpenChange,
  title: heading,
  description: body,
  actions: buttons = [],
  duration,
}: ToastProps) {
  return (
    <RadixToast.Root
      className={root}
      open={open}
      onOpenChange={onOpenChange}
      {...(duration === undefined ? {} : { duration })}
    >
      <RadixToast.Title className={title}>{heading}</RadixToast.Title>
      {body !== undefined && (
        <RadixToast.Description className={description}>{body}</RadixToast.Description>
      )}
      <div className={actions}>
        {buttons.map((action) => (
          <RadixToast.Action key={action.label} altText={action.label} asChild>
            <ToastButton onClick={action.onSelect}>{action.label}</ToastButton>
          </RadixToast.Action>
        ))}
        <RadixToast.Close asChild>
          <ToastButton>Dismiss</ToastButton>
        </RadixToast.Close>
      </div>
    </RadixToast.Root>
  );
}

function ToastButton(props: ComponentPropsWithoutRef<typeof Button>) {
  return <Button variant="secondary" {...props} />;
}
