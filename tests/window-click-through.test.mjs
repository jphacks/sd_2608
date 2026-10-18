import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, deferred, flush } from "./helpers.mjs";
const { startWindowClickThrough } = await fromBuild("application/WindowClickThrough.js");
const { clientPoint, spritePixel, createPochiHitTest } = await fromBuild("pochi/hitTest.js");

function pointer(events, type, x, buttons = 0) {
  events.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: 20, buttons }));
}

test("透過中も OS 座標だけで操作領域へ復帰し、状態が同じなら IPC を増やさない", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let point = { x: 0, y: 0 };
  const calls = [], events = new EventTarget();
  const stop = startWindowClickThrough({ cursorInClient: async () => point,
    ignoreCursor: async ignore => { calls.push(ignore); } }, p => p.x >= 100, events);
  try {
    await flush(); assert.deepEqual(calls, [true]);
    t.mock.timers.tick(32); await flush(); assert.deepEqual(calls, [true]);
    point = { x: 110, y: 20 };
    t.mock.timers.tick(32); await flush(); assert.deepEqual(calls, [true, false]);
    point = { x: 0, y: 0 }; // 通知が閉じた場合も次のポーリングで透過
    t.mock.timers.tick(32); await flush(); assert.deepEqual(calls, [true, false, true]);
  } finally { await stop(); }
  assert.deepEqual(calls, [true, false, true, false]);
});

test("ドラッグ・テキスト選択の押下中は透明部分でも入力を保持し、離すと透過する", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [], events = new EventTarget();
  const stop = startWindowClickThrough({ cursorInClient: async () => ({ x: 0, y: 0 }),
    ignoreCursor: async ignore => { calls.push(ignore); } }, p => p.x >= 100, events);
  try {
    await flush();
    pointer(events, "pointerdown", 110, 1); await flush();
    pointer(events, "pointermove", 0, 1); await flush();
    t.mock.timers.tick(32); await flush();
    assert.deepEqual(calls, [true, false]);
    pointer(events, "pointerup", 0); await flush();
    assert.deepEqual(calls, [true, false, true]);
  } finally { await stop(); }
});

test("押下後に返った古い座標と、停止後の遅い座標は適用しない", async () => {
  const read = deferred(), calls = [], events = new EventTarget();
  const stop = startWindowClickThrough({ cursorInClient: () => read.promise,
    ignoreCursor: async ignore => { calls.push(ignore); } }, p => p.x >= 100, events);
  pointer(events, "pointerdown", 110, 1); await flush();
  read.resolve({ x: 0, y: 0 }); await flush();
  assert.deepEqual(calls, [false]);
  await stop();
  pointer(events, "pointerup", 0); await flush();
  assert.deepEqual(calls, [false]);

  const late = deferred(), after = [];
  const stopLate = startWindowClickThrough({ cursorInClient: () => late.promise,
    ignoreCursor: async ignore => { after.push(ignore); } }, () => false, new EventTarget());
  await stopLate(); late.resolve({ x: 0, y: 0 }); await flush();
  assert.deepEqual(after, [false]);
});

test("透過 IPC 中に停止しても最後に解除し、同時に複数の書き込みを実行しない", async () => {
  const pending = deferred(), calls = [];
  const stop = startWindowClickThrough({ cursorInClient: async () => ({ x: 0, y: 0 }),
    ignoreCursor: async ignore => { calls.push(ignore); if (ignore) await pending.promise; } },
  () => false, new EventTarget());
  await flush(); const cleanup = stop(); await flush();
  assert.deepEqual(calls, [true]);
  pending.resolve(); await cleanup;
  assert.deepEqual(calls, [true, false]);
});

test("座標取得・透過 IPC の失敗時は操作可能へ戻し、監視を停止する", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["read", "write"]) {
    const calls = [], errors = [];
    let reads = 0;
    const stop = startWindowClickThrough({
      cursorInClient: async () => { reads++; if (failure === "read") throw Error("read failed"); return { x: 0, y: 0 }; },
      ignoreCursor: async ignore => { calls.push(ignore); if (ignore) throw Error("write failed"); },
    }, () => false, new EventTarget(), error => errors.push(error));
    await flush(); t.mock.timers.tick(1000); await flush();
    assert.equal(reads, 1); assert.equal(errors.length, 1);
    assert.equal(calls.at(-1), false);
    await stop();
  }
});

test("150%・200% の表示と負座標・移動後のウィンドウ座標を CSS 座標へ変換する", () => {
  assert.deepEqual(clientPoint({ x: -1650, y: 300 }, { x: -1800, y: 150 }, 1.5), { x: 100, y: 100 });
  assert.deepEqual(clientPoint({ x: 2200, y: 500 }, { x: 2000, y: 300 }, 2), { x: 100, y: 100 });
  assert.deepEqual(clientPoint({ x: 2200, y: 500 }, { x: 2100, y: 400 }, 2), { x: 50, y: 50 });
});

test("PNG アトラスの現在フレーム・静止画を同じ CSS 座標から参照する", () => {
  const rect = { left: 200, top: 400, width: 170, height: 170 };
  assert.deepEqual(spritePixel({ x: 285, y: 485 }, rect, 2048, 3584, 4, 7, 25), { x: 768, y: 3328 });
  assert.deepEqual(spritePixel({ x: 285, y: 485 }, rect, 512, 512, 1, 1, 0), { x: 256, y: 256 });
  assert.equal(spritePixel({ x: 370, y: 485 }, rect, 512, 512, 1, 1, 0), null);
  assert.equal(spritePixel({ x: 199, y: 485 }, rect, 512, 512, 1, 1, 0), null);
});

test("背景・非表示 UI は透過し、表示中の操作領域と画像の不透明画素だけを捕捉する", () => {
  let alpha = 0, surface = null;
  const context = { clearRect() {}, drawImage() {}, getImageData: () => ({ data: [0, 0, 0, alpha] }) };
  const sprite = { dataset: { hitSrc: "/pet/pochi/idle-poster.png" },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 170, height: 170 }) };
  const originalImage = globalThis.Image;
  globalThis.Image = class { complete = true; naturalWidth = 512; naturalHeight = 512; };
  try {
    const hit = createPochiHitTest({ createElement: () => ({ getContext: () => context }),
      elementFromPoint: () => surface && ({ closest: () => surface }) });
    assert.equal(hit({ x: 50, y: 50 }), false);
    surface = { dataset: { pochiHit: "" } };
    assert.equal(hit({ x: 50, y: 50 }), true); // 吹き出し・歯車・デモ操作
    surface = { dataset: { pochiHit: "sprite" }, querySelector: () => sprite };
    assert.equal(hit({ x: 50, y: 50 }), false);
    alpha = 255; assert.equal(hit({ x: 50, y: 50 }), true);
  } finally {
    if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage;
  }
});

test("接地位置を補正した現在の絵と同じ画素でクリック判定する", () => {
  const rect = { left: 0, top: 0, width: 512, height: 512 };
  assert.deepEqual(spritePixel({ x: 256, y: 256 }, rect, 2048, 3584, 4, 7, 25, 3), { x: 768, y: 3325 });
  assert.deepEqual(spritePixel({ x: 256, y: 256 }, rect, 2048, 3584, 4, 7, 25, -1), { x: 768, y: 3329 });
  assert.equal(spritePixel({ x: 100, y: 1 }, rect, 512, 512, 1, 1, 0, 3), null);
  assert.equal(spritePixel({ x: 100, y: 511 }, rect, 512, 512, 1, 1, 0, -1), null);
  assert.equal(spritePixel({ x: 100, y: 512 }, rect, 512, 512, 1, 1, 0, 3), null);
});
