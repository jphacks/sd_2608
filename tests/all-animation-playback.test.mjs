import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, flush } from "./helpers.mjs";
const { FramePlayback, motionSequence } = await fromBuild("pochi/spritePlayback.js");
const { arrivalSequence } = await fromBuild("pochi/startup.js");
const ids = ["idle", "reminder", "rest", "record", "welcome", "turn_sit", "rest_to_sit", "sit_to_rest"];
const sequences = [...ids.map(id => motionSequence({ id, token: 0, queue: [], after: id === "rest" ? "rest" : "idle" })), arrivalSequence];

for (const spec of sequences) test(`${spec.id}: 全コマ・ループ境界・再描画・非表示復帰・古い完了を共通時計で検証`, async () => {
  let now = 0, handle = 0;
  const frames = [], complete = [], callbacks = new Map();
  const player = new FramePlayback({ load: async src => src, now: () => now,
    paint: (_image, frame) => { if (frame.src === spec.src) frames.push(frame.frame); },
    complete: token => complete.push(token),
    request: callback => { callbacks.set(++handle, callback); return handle; }, cancel: id => callbacks.delete(id),
  });
  const step = ms => { now += ms; const due = [...callbacks.values()]; callbacks.clear(); due.forEach(callback => callback(now)); };
  player.setSequence(spec, 10, false); await flush();
  assert.equal(frames[0], spec.frames[0]);
  const oldFrame = frames.at(-1);
  player.setHidden(true); step(120_000); player.setHidden(false); step(1);
  assert.equal(frames.at(-1), oldFrame); assert.deepEqual(complete, []);
  const total = spec.durations.reduce((a,b) => a+b, 0), end = now + total * (spec.loop ? 2 : 1) + 20;
  let update = 0;
  while (now < end) {
    if (update++ % 5 === 0) player.setSequence({ ...spec }, 10, false);
    step(10);
  }
  if (spec.loop) {
    assert.deepEqual(frames, [...spec.frames, ...spec.frames, spec.frames[0]]);
    assert.deepEqual(complete, []);
  } else {
    assert.deepEqual(frames, spec.frames); assert.deepEqual(complete, [10]);
    const painted = frames.length; step(1_000); assert.equal(frames.length, painted);
    player.setSequence(spec, 11, false); await flush();
    assert.equal(frames.at(-1), spec.frames[0]); assert.deepEqual(complete, [10]);
  }
  player.dispose(); assert.equal(callbacks.size, 0);
});

test("25fpsの入場は長いフリーズ後にも中間コマをまとめて飛ばさない", async () => {
  let now = 0, callback;
  const frames = [];
  const player = new FramePlayback({ load: async src => src, now: () => now,
    paint: (_image, frame) => frames.push(frame.frame), complete() {},
    request: next => { callback = next; return 1; }, cancel() {},
  });
  player.setSequence(arrivalSequence, 0, false); await flush();
  for (let i = 0; i < 5; i++) { now += 10_000; callback(now); }
  assert.deepEqual([...new Set(frames)], [0, 1, 2, 3, 4, 5]);
  player.dispose();
});
