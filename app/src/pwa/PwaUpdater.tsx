import { useRegisterSW } from "virtual:pwa-register/react";
import { registrationWorker } from "./browser";
import { UpdatePrompt } from "./UpdatePrompt";
import { useUpdates } from "./UpdatesProvider";

/**
 * Registers the service worker, hands its registration to the tab's updater and shows {@link UpdatePrompt} while an update is ready. Not mounted in tests, where there is no service worker.
 */
export function PwaUpdater() {
  const { updater, status } = useUpdates();
  // useRegisterSW reads its options once, on the first render, and the updater outlives the page's renders.
  const { updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration !== undefined) {
        updater.attach(registrationWorker(registration, () => updateServiceWorker(true)));
      }
    },
    onNeedRefresh: () => {
      updater.waiting();
    },
    onNeedReload: () => {
      updater.controllerChanged();
    },
  });
  return (
    <UpdatePrompt
      updateReady={status.prompt}
      onDismiss={() => {
        updater.dismiss();
      }}
      onUpdate={() => {
        updater.applyNow();
      }}
    />
  );
}
