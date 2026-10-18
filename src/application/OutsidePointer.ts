import type { Point } from "./WindowClickThrough.js";

export type NativePointerDown = Point & { targetIsApp: boolean };
export interface OutsidePointerSource {
  listen(callback: (point: NativePointerDown) => void): Promise<() => void>;
  toClient(point: Point): Promise<Point>;
}

/** 背後のアプリへ渡ったクリックも通知する。座標やクリックは保持しない。 */
export function startOutsidePointer(
  source: OutsidePointerSource, hitTest: (point: Point) => boolean, onOutside: () => void,
  onError: (error: unknown) => void = console.error,
): () => Promise<void> {
  let stopped = false, revision = 0;
  const listening = source.listen(point => {
    const read = ++revision;
    if (stopped) return;
    if (!point.targetIsApp) { onOutside(); return; }
    void source.toClient(point).then(client => {
      if (!stopped && read === revision && !hitTest(client)) onOutside();
    }).catch(error => { if (!stopped) onError(error); });
  });
  // StrictMode の解除が購読完了より先に来た場合も必ず解除する。
  void listening.catch(error => { if (!stopped) onError(error); });
  return async () => {
    stopped = true; revision++;
    try { (await listening)(); } catch {}
  };
}
