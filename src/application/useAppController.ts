import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AppGateway } from "../ports/AppGateway.js";
import { AppController } from "./AppController.js";
import { BrowserNotificationAudio } from "../adapters/audio/BrowserNotificationAudio.js";

export function useAppController(gateway: AppGateway) {
  const controller = useMemo(() => new AppController(gateway, new BrowserNotificationAudio()), [gateway]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  useEffect(() => {
    void controller.connect();
    return () => { void controller.dispose(); };
  }, [controller]);
  return { state, actions: controller.actions };
}
