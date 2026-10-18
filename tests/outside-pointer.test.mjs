import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, deferred, flush } from "./helpers.mjs";
const { startOutsidePointer } = await fromBuild("application/OutsidePointer.js");

test("他アプリのクリックと透過領域だけを通知し、犬・吹き出し内では閉じない", async () => {
  let receive, closed = 0, transformed = 0;
  const stop = startOutsidePointer({
    listen: async callback => { receive = callback; return () => {}; },
    toClient: async point => { transformed++; return { x: (point.x + 1800) / 2, y: point.y / 2 }; },
  }, point => point.x >= 100, () => { closed++; });
  receive({ x: -1500, y: 200, targetIsApp: true }); await flush();
  assert.equal(closed, 0);
  receive({ x: -1780, y: 200, targetIsApp: true }); await flush();
  assert.equal(closed, 1);
  // 犬と同じ座標でも、前面にある別アプリをクリックしたら閉じる。
  receive({ x: -1500, y: 200, targetIsApp: false }); await flush();
  assert.equal(closed, 2); assert.equal(transformed, 2);
  await stop();
});

test("遅れた座標変換で新しいクリックや停止後の画面を閉じない", async () => {
  let receive, closed = 0;
  const reading = deferred();
  const stop = startOutsidePointer({ listen: async callback => { receive = callback; return () => {}; },
    toClient: () => reading.promise }, () => false, () => { closed++; });
  receive({ x: 0, y: 0, targetIsApp: true });
  receive({ x: 0, y: 0, targetIsApp: false });
  reading.resolve({ x: 0, y: 0 }); await flush();
  assert.equal(closed, 1);
  await stop(); receive({ x: 0, y: 0, targetIsApp: false });
  assert.equal(closed, 1);
});

test("購読準備中の解除と座標取得中の解除を安全に処理する", async () => {
  let receive, closed = 0, unsubscribed = 0;
  const listening = deferred(), reading = deferred();
  const stop = startOutsidePointer({ listen: callback => { receive = callback; return listening.promise; },
    toClient: () => reading.promise }, () => false, () => { closed++; });
  receive({ x: 0, y: 0, targetIsApp: true });
  const stopped = stop();
  reading.resolve({ x: 0, y: 0 });
  listening.resolve(() => { unsubscribed++; });
  await stopped; await flush();
  assert.equal(closed, 0); assert.equal(unsubscribed, 1);
});
