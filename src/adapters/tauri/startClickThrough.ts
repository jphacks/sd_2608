import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { startWindowClickThrough } from "../../application/WindowClickThrough.js";
import { clientPoint, createPochiHitTest } from "../../pochi/hitTest.js";

export function startNativeClickThrough(ready: Promise<void>): () => Promise<void> {
  const native = getCurrentWindow();
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
  }, createPochiHitTest(document), window);
  return stop;
}
