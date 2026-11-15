import { Toast } from "../ui";

/** Props of {@link UpdatePrompt}. */
export interface UpdatePromptProps {
  /** A new version is ready and the prompt has not been dismissed. */
  readonly updateReady: boolean;
  /** The user dismissed the prompt; the update still loads on its own once nothing is running. */
  readonly onDismiss: () => void;
  /** The user chose to reload onto the new version now. */
  readonly onUpdate: () => void;
}

/** A toast offering to reload onto a new version while it waits for what is running to finish. */
export function UpdatePrompt({ updateReady, onDismiss, onUpdate }: UpdatePromptProps) {
  return (
    <Toast
      open={updateReady}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      duration={Infinity}
      title="A new version is ready"
      description="It loads by itself once nothing is running here. Reload to use it now."
      actions={[{ label: "Reload", onSelect: onUpdate }]}
    />
  );
}
