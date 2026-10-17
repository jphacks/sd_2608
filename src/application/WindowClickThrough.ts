export type Point = { x: number; y: number };

export interface ClickThroughWindow {
  cursorInClient(): Promise<Point>;
  ignoreCursor(ignore: boolean): Promise<void>;
}

/** CSS の pointer-events だけでは OS の背後のウィンドウには入力を渡せない。 */
export function startWindowClickThrough(
  native: ClickThroughWindow,
  hitTest: (point: Point) => boolean,
  events: Pick<Window, "addEventListener" | "removeEventListener">,
  onError: (error: unknown) => void = console.error,
): () => Promise<void> {
  let stopped = false;
  let held = false;
  let revision = 0;
  let applied: boolean | undefined;
  let timer: ReturnType<typeof setTimeout>;
  let writes = Promise.resolve();

  // IPC は直列化し、古い応答や終了前の書き込みで透過状態に戻さない。
  const apply = (ignore: boolean) => {
    writes = writes.catch(() => {}).then(async () => {
      if ((stopped && ignore) || applied === ignore) return;
      await native.ignoreCursor(ignore);
      applied = ignore;
    });
    return writes;
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    removeListeners();
    // 権限・座標取得に失敗した場合も、ペットと終了メニューを操作可能にする。
    void apply(false).catch(onError);
    onError(error);
  };
  const update = (event: PointerEvent) => {
    revision++;
    if (event.type === "pointerdown") held = true;
    else if (event.buttons === 0 || event.type === "pointercancel") held = false;
    void apply(!held && !hitTest({ x: event.clientX, y: event.clientY })).catch(fail);
  };
  const release = () => { held = false; revision++; };
  const removeListeners = () => {
    for (const name of ["pointermove", "pointerdown", "pointerup", "pointercancel"] as const)
      events.removeEventListener(name, update, true);
    events.removeEventListener("blur", release);
  };
  for (const name of ["pointermove", "pointerdown", "pointerup", "pointercancel"] as const)
    events.addEventListener(name, update, true);
  events.addEventListener("blur", release);

  const poll = async () => {
    try {
      const before = revision;
      const point = await native.cursorInClient();
      if (!stopped && before === revision) await apply(!held && !hitTest(point));
    } catch (error) { fail(error); }
    // 透過中は DOM の pointerenter/move が届かないため、OS の座標で復帰する。
    if (!stopped) timer = setTimeout(() => { void poll(); }, 32);
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
    removeListeners();
    return apply(false).catch(onError);
  };
}
