import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fromBuild } from "./helpers.mjs";
const { arrival, arrivalLayout, arrivalSequence } = await fromBuild("pochi/startup.js");

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


test("入場の実行用 PNG は全107コマを固定サイズの図集に格納する", () => {
  const bytes = fs.readFileSync(`public${arrival.atlas}`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "5bfc859582eebbadcb0d38b673214bd93a69279fb8c3fa8c0fa94827c13ffc49");
  assert.equal(bytes.readUInt32BE(16), 3840); assert.equal(bytes.readUInt32BE(20), 4480);
  assert.equal(bytes[25], 6);
  assert.equal(arrivalSequence.loop, false); assert.equal(arrivalSequence.frames.length, 107);
  assert.equal(arrivalSequence.durations.reduce((a,b) => a+b, 0), arrival.durationMs);
  for (const frame of arrivalSequence.frames) {
    const crop = arrivalSequence.frame(frame);
    assert.equal(crop.tileWidth, 480); assert.equal(crop.tileHeight, 320);
    assert.ok(frame < crop.columns * crop.rows);
  }
});
