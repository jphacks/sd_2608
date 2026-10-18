import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { startOutsidePointer } from "../../application/OutsidePointer.js";
import type { NativePointerDown } from "../../application/OutsidePointer.js";
import { startWindowClickThrough } from "../../application/WindowClickThrough.js";
import { clientPoint, createPochiHitTest } from "../../pochi/hitTest.js";

export function startNativeClickThrough(ready: Promise<void>): () => Promise<void> {
  const native = getCurrentWindow();
  const hitTest = createPochiHitTest(document);
  const stop = startWindowClickThrough({
    async cursorInClient() {
      await ready;
      const [cursor, origin, scale] = await Promise.all([
        cursorPosition(), native.innerPosition(), native.scaleFactor(),
      ]);
      return clientPoint(cursor, origin, scale);
    },
    async ignoreCursor(ignore) {
      await ready;
      await native.setIgnoreCursorEvents(ignore);
    },
  }, hitTest, window);
  const stopOutside = startOutsidePointer({
    async listen(callback) {
      await ready;
      return listen<NativePointerDown>("app://pointer-down", event => callback(event.payload));
    },
    async toClient(point) {
      const [origin, scale] = await Promise.all([native.innerPosition(), native.scaleFactor()]);
      return clientPoint(point, origin, scale);
    },
  }, hitTest, () => window.dispatchEvent(new Event("pochi:outside-pointerdown")));
  return async () => { await Promise.all([stop(), stopOutside()]); };
}
