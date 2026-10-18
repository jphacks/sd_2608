import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, flush } from "./helpers.mjs";
const { SpritePlayback, spriteFrame } = await fromBuild("pochi/spritePlayback.js");
const { animationSpec, initialMotion, moveTo, finishMotion } = await fromBuild("pochi/animation.js");
const motion = (id, token = 1) => ({ id, token, queue: [], after: id === "rest" || id === "sit_to_rest" ? "rest" : "idle" });

function harness(load = async src => src) {
  let now = 0, next = 0;
  const paints = [], completed = [], callbacks = new Map();
  const player = new SpritePlayback({ load, now: () => now,
    paint: (image, frame) => paints.push({ image, ...frame }), complete: token => completed.push(token),
    request: callback => { callbacks.set(++next, callback); return next; }, cancel: id => callbacks.delete(id),
  });
  return { player, paints, completed, callbacks,
    step(ms = 16) { now += ms; const due = [...callbacks.values()]; callbacks.clear(); due.forEach(callback => callback(now)); },
    async play(id, token = 1) { player.setMotion(motion(id, token), false); await flush(); },
  };
}

test("正逆再生の全フレームが共通の接地線に揃い、共有する終端ポーズも一致する", () => {
  for (const id of ["idle", "reminder", "rest", "record", "welcome", "turn_sit", "rest_to_sit", "sit_to_rest"]) {
    const spec = animationSpec(id);
    for (const frame of spec.frames) assert.ok(Math.abs(spriteFrame(id, frame).offsetY) <= 4);
  }
  assert.equal(spriteFrame("rest", 0).offsetY, spriteFrame("rest_to_sit", 0).offsetY);
  assert.equal(spriteFrame("idle", 0).offsetY, spriteFrame("rest_to_sit", 25).offsetY);
  assert.deepEqual(spriteFrame("sit_to_rest", 25), spriteFrame("rest_to_sit", 25));
});

test("1回動作は表示した全フレームと同じ時計で終了し、最終フレームを描画してから一度だけ通知する", async () => {
  for (const id of ["reminder", "record", "welcome", "turn_sit", "rest_to_sit", "sit_to_rest"]) {
    const h = harness(); await h.play(id);
    for (let i = 0; i < 1000 && !h.completed.length; i++) h.step(10);
    const actual = h.paints.filter(p => p.src === animationSpec(id).src).map(p => p.frame);
    assert.deepEqual(actual, animationSpec(id).frames, id);
    assert.deepEqual(h.completed, [1]);
    h.step(1000); assert.deepEqual(h.completed, [1]); assert.equal(h.callbacks.size, 0);
  }
});

test("次の画像が遅れても直前の絵を保ち、古い読込の完了は現在の動作を上書きしない", async () => {
  const pending = new Map();
  const h = harness(src => src.includes("poster") || src.endsWith("idle.png") ? Promise.resolve(src)
    : new Promise(resolve => pending.set(src, () => resolve(src))));
  await h.play("idle"); const previous = h.paints.at(-1), count = h.paints.length;
  await h.play("welcome", 2); h.step(200);
  assert.equal(h.paints.length, count); assert.equal(h.paints.at(-1), previous);
  await h.play("rest", 3);
  pending.get("/pet/pochi/rest.png")(); await flush();
  pending.get("/pet/pochi/welcome.png")(); await flush();
  assert.equal(h.paints.at(-1).src, "/pet/pochi/rest.png"); assert.deepEqual(h.completed, []);
});

test("同じ再生トークンの再描画・キュー変更で途中から先頭へ戻らない", async () => {
  const h = harness(); await h.play("rest_to_sit");
  for (let i = 0; i < 5; i++) h.step(100);
  const previous = h.paints.at(-1), count = h.paints.length;
  h.player.setMotion({ ...motion("rest_to_sit"), queue: ["sit_to_rest"], after: "rest" }, false);
  await flush();
  assert.equal(h.paints.length, count); assert.equal(h.paints.at(-1), previous);
  h.step(100); assert.ok(h.paints.at(-1).frame >= previous.frame);
});

test("非表示の時間を再生時間に加算せず、復帰後は途中のポーズから続ける", async () => {
  const h = harness(); await h.play("rest_to_sit"); h.step(100);
  const frame = h.paints.at(-1).frame;
  h.player.setHidden(true); h.step(60_000);
  assert.equal(h.paints.at(-1).frame, frame); assert.equal(h.callbacks.size, 0);
  h.player.setHidden(false); h.step(16);
  assert.equal(h.paints.at(-1).frame, frame); assert.deepEqual(h.completed, []);
  h.step(100); assert.ok(h.paints.at(-1).frame > frame);
});

test("読込中に非表示になった場合も、復帰直後に動作を飛ばさない", async () => {
  let resolve;
  const h = harness(src => src.endsWith("welcome.png") ? new Promise(done => { resolve = done; }) : Promise.resolve(src));
  await h.play("welcome"); h.player.setHidden(true); resolve("welcome"); await flush(); h.step(60_000);
  h.player.setHidden(false); h.step(16);
  assert.equal(h.paints.at(-1).frame, 0); assert.deepEqual(h.completed, []);
});

test("前景で処理が詰まっても一度に起き上がり全体を飛ばさない", async () => {
  const h = harness(); await h.play("rest_to_sit"); h.step(10_000);
  assert.equal(h.paints.at(-1).frame, 0); assert.deepEqual(h.completed, []);
  h.step(100); assert.equal(h.paints.at(-1).frame, 1);
});

test("待機・休憩は繰り返し、同じ姿勢への更新で再生トークンを増やさない", async () => {
  for (const id of ["idle", "rest"]) {
    const h = harness(); await h.play(id);
    for (let i = 0; i < 100; i++) h.step(100);
    assert.deepEqual(h.completed, []); assert.equal(h.callbacks.size, 1);
    const current = motion(id); assert.equal(moveTo(current, id), current);
    assert.equal(finishMotion(current, current.token), current);
    h.player.dispose();
  }
  assert.equal(moveTo(initialMotion(), "idle").token, 0);
});

test("動きを減らす設定でも一度動作の完了を返し、ループの完了は返さない", async () => {
  const h = harness(); h.player.setMotion(motion("rest_to_sit"), true); await flush(); h.step();
  assert.equal(h.paints.at(-1).src, "/pet/pochi/idle-poster.png"); assert.deepEqual(h.completed, [1]);
  h.player.setMotion(motion("rest", 2), true); await flush(); h.step();
  assert.equal(h.paints.at(-1).src, "/pet/pochi/rest-poster.png"); assert.deepEqual(h.completed, [1]);
});

test("画像の読込失敗でも直前の画面を消さず、短い動作の完了待ちで固まらない", async () => {
  const h = harness(src => src.includes("welcome") ? Promise.reject(Error("missing")) : Promise.resolve(src));
  await h.play("idle"); await h.play("welcome", 2); h.step();
  assert.equal(h.paints.at(-1).src, "/pet/pochi/idle-poster.png"); assert.deepEqual(h.completed, [2]);
});

test("中断前の予約フレーム・破棄後の遅い読込で描画や完了通知を発生させない", async () => {
  const h = harness(); await h.play("welcome"); const stale = [...h.callbacks.values()][0];
  await h.play("rest", 2); const count = h.paints.length; stale(3000);
  assert.equal(h.paints.length, count); assert.deepEqual(h.completed, []); assert.equal(h.callbacks.size, 1);
  h.player.dispose(); h.step(100); assert.equal(h.callbacks.size, 0);
  let resolve;
  const late = harness(() => new Promise(done => { resolve = done; }));
  await late.play("rest_to_sit"); late.player.dispose(); resolve("late"); await flush();
  assert.equal(late.paints.length, 0); assert.deepEqual(late.completed, []);
});
