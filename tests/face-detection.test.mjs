import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, deferred, flush } from "./helpers.mjs";
const { FaceDetectionController } = await fromBuild("adapters/camera/FaceDetectionController.js");

class Scheduler {
  time = 0; serial = 0; jobs = new Map();
  after = (ms, callback) => { const id = ++this.serial; this.jobs.set(id, { at: this.time + ms, callback }); return () => this.jobs.delete(id); };
  async advance(ms) {
    const target = this.time + ms;
    for (let n = 0; n < 100; n++) {
      await flush();
      const [id, job] = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (!job || job.at > target) { this.time = target; await flush(); return; }
      this.jobs.delete(id); this.time = job.at; job.callback();
    }
    throw new Error("timer loop");
  }
}
function media() {
  const track = Object.assign(new EventTarget(), { readyState: "live", stops: 0, stop() { this.stops++; this.readyState = "ended"; } });
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}
function setup(source = "camera") {
  const scheduler = new Scheduler(); const { track, stream } = media();
  const video = { muted: false, playsInline: false, srcObject: null, readyState: 2,
    get currentTime() { return scheduler.time / 1_000; }, play: async () => {}, pause() {} };
  const detector = { calls: 0, closes: 0, detected: true, detect() { this.calls++; return this.detected; }, close() { this.closes++; } };
  const calls = { permission: 0, detector: 0 };
  const dependencies = { getUserMedia: async () => { calls.permission++; return stream; }, createVideo: () => video,
    loadDetector: async () => { calls.detector++; return detector; }, now: () => 10_000 + scheduler.time,
    monotonic: () => scheduler.time, after: scheduler.after };
  const inputs = [];
  const submit = async input => { inputs.push(structuredClone(input)); return true; };
  const controller = new FaceDetectionController(dependencies, source);
  return { scheduler, track, stream, video, detector, calls, dependencies, inputs, submit, controller };
}

test("新しいフレームだけを約1秒周期で送り、boolean以外の映像情報を送らず停止で解放する", async () => {
  const f = setup(); f.controller.start("tracking-1", f.submit); await f.scheduler.advance(2_000);
  assert.equal(f.detector.calls, 3); assert.deepEqual(f.inputs.map(i => i.sequence), [1, 2, 3]);
  assert.deepEqual(Object.keys(f.inputs[0]).sort(), ["trackingId", "sequence", "observedAt", "source", "kind", "faceDetected"].sort());
  f.detector.detected = false; await f.scheduler.advance(1_000); assert.equal(f.inputs.at(-1).faceDetected, false);
  f.controller.stop(); assert.equal(f.track.stops, 1); assert.equal(f.detector.closes, 1); assert.equal(f.video.srcObject, null);
  assert.equal(f.scheduler.jobs.size, 0); await f.scheduler.advance(10_000); assert.equal(f.inputs.length, 4);
});
test("停止後に許可された旧ストリームを解放し、新しいカメラへ混ぜない", async () => {
  const f = setup(); const permission = deferred(); f.dependencies.getUserMedia = () => permission.promise;
  f.controller.start("old", f.submit); f.controller.stop();
  const next = media(); f.dependencies.getUserMedia = async () => next.stream;
  f.controller.start("new", f.submit); await flush(); permission.resolve(f.stream); await flush();
  assert.equal(f.track.stops, 1); assert.equal(next.track.stops, 0);
  assert.ok(f.inputs.every(input => input.trackingId === "new")); f.controller.stop(); assert.equal(next.track.stops, 1);
});
test("モデル読込中の停止では遅い検出器を閉じ、タイマーを残さない", async () => {
  const f = setup(); const loading = deferred(); f.dependencies.loadDetector = () => loading.promise;
  f.controller.start("old", f.submit); await flush(); f.controller.stop(); loading.resolve(f.detector); await flush();
  assert.equal(f.detector.closes, 1); assert.equal(f.track.stops, 1); assert.equal(f.inputs.length, 0); assert.equal(f.scheduler.jobs.size, 0);
});
test("権限拒否を顔なしと混同せず denied を一度だけ送る", async () => {
  const f = setup(); f.dependencies.getUserMedia = async () => { throw new DOMException("private-detail", "NotAllowedError"); };
  f.controller.start("tracking", f.submit); await flush();
  assert.deepEqual(f.inputs.map(i => [i.kind, i.reason]), [["unavailable", "denied"]]);
  assert.ok(!JSON.stringify(f.inputs).includes("private-detail")); assert.equal(f.calls.detector, 0); assert.equal(f.scheduler.jobs.size, 0);
});
test("再生開始・モデル読込・権限待ちがタイムアウトしても遅いリソースを回収する", async () => {
  for (const stage of ["play", "model", "permission"]) {
    const f = setup(); const pending = deferred();
    if (stage === "play") f.video.play = () => pending.promise;
    if (stage === "model") f.dependencies.loadDetector = () => pending.promise;
    if (stage === "permission") f.dependencies.getUserMedia = () => pending.promise;
    f.controller.start("tracking", f.submit); await flush(); await f.scheduler.advance(30_001);
    assert.equal(f.inputs.at(-1).reason, "deviceError", stage);
    pending.resolve(stage === "permission" ? f.stream : stage === "model" ? f.detector : undefined); await flush();
    assert.equal(f.track.stops, 1, stage); assert.equal(f.scheduler.jobs.size, 0, stage);
    if (stage === "model") assert.equal(f.detector.closes, 1);
  }
});
test("切断・推論失敗・フレーム停止は unavailable となり映像取得を止める", async () => {
  for (const reason of ["ended", "detect", "stalled"]) {
    const f = setup();
    if (reason === "detect") f.detector.detect = () => { throw new Error("private-inference-error"); };
    if (reason === "stalled") Object.defineProperty(f.video, "currentTime", { get: () => 0 });
    f.controller.start("tracking", f.submit); await flush();
    if (reason === "ended") f.track.dispatchEvent(new Event("ended"));
    await f.scheduler.advance(5_000);
    assert.equal(f.inputs.at(-1).kind, "unavailable", reason); assert.equal(f.inputs.at(-1).reason, "deviceError");
    assert.equal(f.track.stops, 1); assert.equal(f.detector.closes, 1); assert.equal(f.scheduler.jobs.size, 0);
    if (reason === "stalled") assert.equal(f.detector.calls, 1);
  }
});
test("遅いIPC中に切断しても送信は直列、停止すれば遅い unavailable を送らない", async () => {
  for (const stop of [false, true]) {
    const f = setup(); const pending = deferred();
    f.controller.start("tracking", async input => { f.inputs.push(input); return input.kind === "sample" ? pending.promise : true; });
    await flush(); await f.scheduler.advance(3_000); assert.equal(f.inputs.length, 1);
    f.track.dispatchEvent(new Event("ended")); await flush(); assert.equal(f.track.stops, 1); assert.equal(f.inputs.length, 1);
    assert.equal(f.scheduler.jobs.size, 0);
    if (stop) f.controller.stop();
    pending.resolve(true); await flush(); assert.equal(f.inputs.length, stop ? 1 : 2);
    if (!stop) assert.deepEqual(f.inputs.map(i => i.sequence), [1, 2]);
  }
});
test("手動ソースはカメラ・モデルを起動せず source と顔の有無を送る", async () => {
  const f = setup("manual"); f.controller.start("manual", f.submit); await flush();
  f.controller.setFaceDetected(true); await f.scheduler.advance(1_000);
  assert.deepEqual(f.inputs.map(i => [i.source, i.faceDetected]), [["manual", false], ["manual", true]]);
  assert.deepEqual(f.calls, { permission: 0, detector: 0 }); f.controller.stop(); assert.equal(f.scheduler.jobs.size, 0);
});
test("送信が応答しない場合も5秒でカメラを閉じ、停止後に送信を復活させない", async () => {
  const f = setup(); const pending = deferred();
  f.controller.start("tracking", async input => { f.inputs.push(input); return pending.promise; });
  await flush(); await f.scheduler.advance(5_000);
  assert.equal(f.track.stops, 1); assert.equal(f.inputs.length, 1);
  f.controller.stop(); pending.resolve(true); await flush(); assert.equal(f.inputs.length, 1);
  assert.equal(f.scheduler.jobs.size, 0);
});
