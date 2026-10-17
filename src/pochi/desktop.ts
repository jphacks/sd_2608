import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
export const isDesktop = isTauri();
export const desktop = {
  async pin(value: boolean) { if (isDesktop) await getCurrentWindow().setAlwaysOnTop(value); },
  async drag() { if (isDesktop) await getCurrentWindow().startDragging(); },
  async close() { if (isDesktop) await getCurrentWindow().destroy(); },
  async onClose(handler: () => void) {
    return isDesktop ? getCurrentWindow().onCloseRequested(event => { event.preventDefault(); handler(); }) : () => {};
  },
};
