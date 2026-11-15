import { Toast } from "../ui";

/** Props of {@link UpdatePrompt}. */
export interface UpdatePromptProps {
  /** A new service worker is waiting. */
  readonly updateReady: boolean;
  /** The user dismissed the prompt; the update waits for the next visit. */
  readonly onDismiss: () => void;
  /** The user chose to reload onto the new version. */
  readonly onUpdate: () => void;
}

/** A toast offering to reload onto a new version once its service worker is waiting. */
export function UpdatePrompt({ updateReady, onDismiss, onUpdate }: UpdatePromptProps) {
  return (
    <Toast
      open={updateReady}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      duration={Infinity}
      title="A new version is ready"
      description="Reload to use it. Anything running now is not interrupted until you do."
      actions={[{ label: "Reload", onSelect: onUpdate }]}
    />
  );
}
