import { useRegisterSW } from "virtual:pwa-register/react";
import { UpdatePrompt } from "./UpdatePrompt";

/**
 * Registers the service worker and offers updates through {@link UpdatePrompt}. Not mounted in
 * tests, where there is no service worker.
 */
export function PwaUpdater() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  return (
    <UpdatePrompt
      updateReady={needRefresh}
      onDismiss={() => {
        setNeedRefresh(false);
      }}
      onUpdate={() => void updateServiceWorker(true)}
    />
  );
}
