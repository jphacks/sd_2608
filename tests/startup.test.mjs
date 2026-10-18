import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fromBuild } from "./helpers.mjs";
const { arrival, arrivalLayout, ArrivalPlayback } = await fromBuild("pochi/startup.js");

function player() {
  let completions = 0; const timers = [];
  const playback = new ArrivalPlayback(() => completions++, (callback, ms) => {
    const timer = { callback, ms, cancelled: false }; timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  return { playback, timers, completions: () => completions };
}
test("起動画像の読込後に一度だけ再生し、重複loadと完了通知を無視する", () => {
  const p = player(); assert.equal(p.timers.length, 0);
  p.playback.loaded(); p.playback.loaded();
  assert.equal(p.timers.length, 1); assert.equal(p.timers[0].ms, 4280);
  p.timers[0].callback(); p.timers[0].callback(); p.playback.loaded();
  assert.equal(p.completions(), 1); assert.equal(p.timers.length, 1);
});
test("読込失敗・動きを減らす場合は待機せず、解除後の遅いloadでは再開しない", () => {
  const p = player(); p.playback.skip(); p.playback.loaded(); p.playback.skip();
  assert.equal(p.completions(), 1); assert.equal(p.timers.length, 0);
  const disposed = player(); disposed.playback.loaded(); disposed.playback.dispose();
  assert.equal(disposed.timers[0].cancelled, true);
  disposed.timers[0].callback(); disposed.playback.loaded(); assert.equal(disposed.completions(), 0);
});
test("起動APNGは承認済みv3そのもので、107フレーム・4.28秒・1回再生・透過を持つ", () => {
  const bytes = fs.readFileSync(`public${arrival.src}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "6aacf55ea37da6a5ce03e6d9fc70ddaf4638e3b17f636923ae6fec170a70fd39");
  assert.equal(bytes.readUInt32BE(16), 960); assert.equal(bytes.readUInt32BE(20), 640);
  assert.equal(bytes[25], 6); // RGBA
  let frames = 0, duration = 0, plays = -1;
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8), start = offset + 8;
    if (type === "acTL") { assert.equal(bytes.readUInt32BE(start), arrival.frameCount); plays = bytes.readUInt32BE(start + 4); }
    if (type === "fcTL") { frames++; duration += 1000 * bytes.readUInt16BE(start + 20) / (bytes.readUInt16BE(start + 22) || 100); }
    offset += size + 12;
  }
  assert.equal(plays, 1); assert.equal(frames, 107); assert.equal(duration, arrival.durationMs);
  const poster = fs.readFileSync(`public${arrival.poster}`);
  assert.equal(createHash("sha256").update(poster).digest("hex"), "addd6e34c84a1186d2ad4b2c60c030f1cd6016185019b9f9264994a654278eeb");
});
test("余白付きの入場画像の終点と既存の伏せ画像の足元・横幅が揃う", () => {
  const scale = arrivalLayout.width / arrival.width;
  assert.ok(Math.abs(arrivalLayout.height / arrival.height - scale) < 1e-9);
  assert.ok(Math.abs(arrivalLayout.left + 86 * scale - 29 / 512 * 170) < 1e-6);
  assert.ok(Math.abs(arrivalLayout.left + 535 * scale - 483 / 512 * 170) < 1e-6);
  assert.ok(Math.abs(arrivalLayout.top + 541 * scale - 480 / 512 * 170) < 1e-6);
});

