import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, deferred, flush } from "./helpers.mjs";

const { TauriGateway } = await fromBuild("adapters/tauri/TauriGateway.js");
const { AppController } = await fromBuild("application/AppController.js");
const { GatewayConnectionError } = await fromBuild("ports/AppGateway.js");
const { createSnapshot } = await fromBuild("contracts/fixtures.js");
const success = data => ({ ok: true, data });
const failure = (code = "invalidState") => ({ ok: false, error: { code, message: "接続先のエラーです。", retryable: false } });
const snapshot = (revision = 0, runtimeId = "native-runtime") => ({ ...createSnapshot(), revision, runtimeId });

class Environment {
  intervals = new Set(); resumes = new Set(); serial = 0;
  every = (milliseconds, callback) => { assert.equal(milliseconds, 5_000); this.intervals.add(callback); return () => this.intervals.delete(callback); };
  onResume = callback => { this.resumes.add(callback); return () => this.resumes.delete(callback); };
  requestId = () => `request-${++this.serial}`;
  poll() { for (const callback of this.intervals) callback(); }
  resume() { for (const callback of this.resumes) callback(); }
}
class Transport {
  calls = []; listeners = new Set(); order = [];
  handler = async command => command === "app_get_snapshot" ? success(snapshot()) : command === "report_list" ? success({ items: [], nextCursor: null }) : failure();
  invoke = async (command, args) => { this.order.push(command); this.calls.push({ command, args }); return this.handler(command, args); };
  listen = async (name, listener) => { assert.equal(name, "app://snapshot"); this.order.push("listen"); this.listeners.add(listener); return () => this.listeners.delete(listener); };
  emit(value) { for (const listener of this.listeners) listener(structuredClone(value)); }
}
function setup(captures) { const transport = new Transport(); const environment = new Environment(); return { transport, environment, gateway: new TauriGateway(transport, environment, captures) }; }

test("購読後に初期状態を取得し、その間のイベントを新しい revision 優先で適用する", async () => {
  const { gateway, transport, environment } = setup();
  const pending = deferred(); transport.handler = () => pending.promise;
  const observed = []; const connecting = gateway.connect(value => observed.push(value)); await flush();
  transport.emit(snapshot(8)); transport.emit(snapshot(5)); pending.resolve(success(snapshot(1)));
  assert.equal((await connecting).revision, 8);
  assert.deepEqual(transport.order, ["listen", "app_get_snapshot"]);
  assert.deepEqual(observed.map(value => value.revision), [8]);
  assert.equal(environment.intervals.size, 1); assert.equal(environment.resumes.size, 1);
  await gateway.dispose(); assert.equal(transport.listeners.size, 0); assert.equal(environment.intervals.size, 0); assert.equal(environment.resumes.size, 0);
});

test("未接続操作は拒否し、接続後の要求には request を1段で包み requestId を生成する", async () => {
  const { gateway, transport } = setup();
  assert.equal((await gateway.clearData()).error.code, "invalidState"); assert.equal(transport.calls.length, 0);
  await gateway.connect(() => {});
  const result = await gateway.start({ profile: "normal", expectedSettingsRevision: 0, reportMode: "local", consent: { activity: true, history: true, externalReport: false } });
  assert.equal(result.ok, false); assert.equal(result.error.code, "invalidState");
  assert.equal(transport.calls.at(-1).command, "runtime_start");
  const requestId = transport.calls.at(-1).args.request.requestId;
  assert.match(requestId, /^request-\d+$/);
  assert.deepEqual(transport.calls.at(-1).args, { request: { requestId, profile: "normal", expectedSettingsRevision: 0, reportMode: "local", consent: { activity: true, history: true, externalReport: false } } });
  await gateway.dispose();
});

test("初期応答が不正なら安全なエラーを返して、購読とタイマーを残さない", async () => {
  const { gateway, transport, environment } = setup();
  transport.handler = async () => ({ ok: true, data: { sensitive: "must-not-echo" } });
  await assert.rejects(gateway.connect(() => {}), cause => cause instanceof GatewayConnectionError && cause.detail.code === "invalidResponse" && !cause.message.includes("must-not-echo"));
  assert.equal(transport.listeners.size, 0); assert.equal(environment.intervals.size, 0);
});

test("失敗応答と通信例外を区別し、不正な成功・失敗応答を信用しない", async () => {
  const { gateway, transport } = setup(); await gateway.connect(() => {});
  transport.handler = async () => failure("notFound"); assert.equal((await gateway.getReport("missing")).error.code, "notFound");
  transport.handler = async () => { throw new Error("private-native-detail"); };
  const thrown = await gateway.getReport("missing"); assert.equal(thrown.error.code, "internal"); assert.ok(!thrown.error.message.includes("private-native-detail"));
  transport.handler = async () => ({ ok: false, error: { code: "future", message: "bad", retryable: false } });
  assert.equal((await gateway.getReport("missing")).error.code, "invalidResponse");
  await gateway.dispose();
});

test("イベントの後に古いコマンド応答が返っても状態を巻き戻さない", async () => {
  const { gateway, transport } = setup(); const observed = []; await gateway.connect(value => observed.push(value));
  const pending = deferred(); transport.handler = () => pending.promise;
  const clearing = gateway.clearData(); transport.emit(snapshot(4)); pending.resolve(success(snapshot(2))); await clearing;
  assert.deepEqual(observed.map(value => value.revision), [4]); await gateway.dispose();
});

test("5秒ポーリングと画面復帰を再同期し、同時取得を直列化する", async () => {
  const { gateway, transport, environment } = setup(); const observed = []; await gateway.connect(value => observed.push(value));
  const pending = deferred(); let reads = 0;
  transport.handler = async () => ++reads === 1 ? pending.promise : success(snapshot(3));
  environment.poll(); await flush(); environment.poll(); await flush(); assert.equal(reads, 1);
  pending.resolve(success(snapshot(2))); await flush();
  assert.equal(reads, 2); assert.deepEqual(observed.map(value => value.revision), [2, 3]);
  environment.resume(); await flush(); assert.equal(reads, 3); await gateway.dispose();
});

test("不正イベントを描画せず再取得し、通信障害から同じ revision でも回復できる", async () => {
  const { gateway, transport, environment } = setup();
  const controller = new AppController(gateway); await controller.connect();
  transport.handler = async () => { throw new Error("offline"); };
  environment.poll(); await flush(); assert.equal(controller.getState().connection, "error");
  transport.handler = async () => success(snapshot());
  environment.resume(); await flush(); assert.equal(controller.getState().connection, "connected");
  transport.emit({ apiVersion: 99 }); await flush();
  assert.equal(controller.getState().snapshot.apiVersion, 1); assert.equal(controller.getState().connection, "connected");
  await controller.dispose();
});

test("未知 runtime のイベントは再取得で確認し、退役した runtime のイベントは無視する", async () => {
  const { gateway, transport } = setup(); const observed = []; await gateway.connect(value => observed.push(value));
  transport.handler = async () => success(snapshot(1, "restarted-runtime"));
  transport.emit(snapshot(99, "restarted-runtime")); await flush();
  assert.deepEqual(observed.map(value => [value.runtimeId, value.revision]), [["restarted-runtime", 1]]);
  const calls = transport.calls.length;
  transport.emit(snapshot(100, "native-runtime")); await flush(); assert.equal(transport.calls.length, calls);
  await gateway.dispose();
});

test("解除中の listen 完了が遅れても、再接続後の新しい購読を消さない", async () => {
  const { gateway, transport, environment } = setup(); const late = deferred(); let subscriptions = 0; let oldRemoved = 0;
  const listen = transport.listen;
  transport.listen = async (...args) => ++subscriptions === 1 ? late.promise : listen(...args);
  const first = gateway.connect(() => {}); const rejected = assert.rejects(first, cause => cause.detail.code === "cancelled");
  await gateway.dispose(); await gateway.connect(() => {});
  late.resolve(() => { oldRemoved++; }); await rejected;
  assert.equal(oldRemoved, 1); assert.equal(transport.listeners.size, 1); assert.equal(environment.intervals.size, 1);
  await gateway.dispose(); assert.equal(transport.listeners.size, 0);
});

test("解除後に受理された開始を、返却された古い trackingId だけで停止する", async () => {
  const { gateway, transport } = setup(); await gateway.connect(() => {});
  const pending = deferred();
  transport.handler = async command => command === "runtime_start" ? pending.promise : command === "app_get_snapshot" ? success(snapshot()) : failure("staleTracking");
  const starting = gateway.start({ profile: "normal", expectedSettingsRevision: 0, reportMode: "local", consent: { activity: true, history: true, externalReport: false } });
  await gateway.dispose(); await gateway.connect(() => {});
  const old = snapshot(1); old.runtime.phase = "running"; old.runtime.trackingId = "old-tracking";
  pending.resolve(success(old)); assert.equal((await starting).error.code, "cancelled");
  assert.equal(transport.calls.at(-1).command, "runtime_stop"); assert.equal(transport.calls.at(-1).args.request.trackingId, "old-tracking");
  await gateway.dispose();
});

test("解除後のポーリング応答は新しい画面に通知しない", async () => {
  const { gateway, transport, environment } = setup(); const observed = []; await gateway.connect(value => observed.push(value));
  const pending = deferred(); transport.handler = () => pending.promise;
  environment.poll(); await gateway.dispose(); pending.resolve(success(snapshot(5))); await flush();
  assert.deepEqual(observed, []); assert.equal(environment.intervals.size, 0);
});

const startInput = { profile: "normal", expectedSettingsRevision: 0, reportMode: "local", consent: { activity: true, history: true, externalReport: false } };
class Capture {
  starts = []; stops = 0; detected = false;
  start(trackingId, submit) { this.starts.push({ trackingId, submit }); }
  stop() { this.stops++; }
  setFaceDetected(value) { this.detected = value; }
}
function captureSetup() {
  const camera = new Capture(); const manual = new Capture(); const f = setup({ camera, manual });
  let current = snapshot();
  f.transport.handler = async (command, args) => {
    if (command === "runtime_start") {
      current = snapshot(current.revision + 1);
      current.runtime = { ...current.runtime, phase: "running", trackingId: `tracking-${current.revision}`,
        profile: args.request.profile, camera: "waiting", activity: "running", consent: args.request.consent };
      return success(structuredClone(current));
    }
    if (command === "runtime_stop") {
      if (args.request.trackingId !== current.runtime.trackingId) return failure("staleTracking");
      current = snapshot(current.revision + 1); return success(current);
    }
    if (command === "face_submit") return success({ acceptedSequence: args.request.sequence, snapshotRevision: current.revision + 1 });
    return success(structuredClone(current));
  };
  return { ...f, camera, manual };
}
test("通常・デモともに同意した開始が成功してから実カメラの経路を使い、短縮プロファイルと取得元を保つ", async () => {
  for (const profile of ["normal", "demo"]) {
    const f = captureSetup(); await f.gateway.connect(() => {});
    assert.equal(f.camera.starts.length, 0);
    const result = await f.gateway.start({ ...startInput, profile }); assert.equal(result.ok, true);
    assert.equal(result.data.runtime.profile, profile);
    assert.equal(f.transport.calls.find(call => call.command === "runtime_start").args.request.profile, profile);
    assert.equal(f.manual.starts.length, 0);
    const capture = f.camera.starts[0]; assert.equal(capture.trackingId, result.data.runtime.trackingId);
    assert.equal(await capture.submit({ trackingId: capture.trackingId, sequence: 1, observedAt: 10_000, source: "camera", kind: "sample", faceDetected: false }), true);
    assert.equal(f.transport.calls.at(-1).command, "face_submit");
    assert.equal(f.transport.calls.at(-1).args.request.source, "camera");
    assert.equal(f.transport.calls.at(-1).args.request.faceDetected, false);
    await f.gateway.dispose(); assert.equal(f.camera.stops, 1);
  }
});

test("デモでカメラの開始に失敗しても手動入力へ切り替えず、記録を停止する", async () => {
  const f = captureSetup(); await f.gateway.connect(() => {});
  f.camera.start = () => { throw new Error("camera unavailable"); };
  const result = await f.gateway.start({ ...startInput, profile: "demo" });
  assert.equal(result.ok, false); assert.equal(result.error.code, "internal");
  assert.equal(f.manual.starts.length, 0); assert.equal(f.camera.stops, 1);
  assert.ok(f.transport.calls.some(call => call.command === "runtime_stop"));
  await f.gateway.dispose();
});
test("停止のIPCが失敗・遅延してもカメラは直ちに解放し、古い停止要求では新カメラを止めない", async () => {
  const f = captureSetup(); await f.gateway.connect(() => {}); const started = await f.gateway.start(startInput);
  assert.equal((await f.gateway.stop("obsolete")).error.code, "staleTracking"); assert.equal(f.camera.stops, 0);
  const pending = deferred(); f.transport.handler = () => pending.promise;
  const stopping = f.gateway.stop(started.data.runtime.trackingId); assert.equal(f.camera.stops, 1);
  pending.resolve(failure("internal")); assert.equal((await stopping).ok, false);
  assert.equal(await f.camera.starts[0].submit({}), false); await f.gateway.dispose();
});
test("開始受付中の削除・解除や新しい停止イベントの後にカメラを復活させない", async () => {
  for (const action of ["clear", "dispose", "event"]) {
    const f = captureSetup(); await f.gateway.connect(() => {}); const pending = deferred();
    const running = snapshot(1); running.runtime = { ...running.runtime, phase: "running", trackingId: "late", camera: "waiting" };
    f.transport.handler = async command => command === "runtime_start" ? pending.promise : success(snapshot(2));
    const starting = f.gateway.start(startInput);
    if (action === "clear") await f.gateway.clearData();
    if (action === "dispose") await f.gateway.dispose();
    if (action === "event") f.transport.emit(snapshot(2));
    pending.resolve(success(running)); assert.equal((await starting).error.code, "cancelled", action);
    assert.equal(f.camera.starts.length, 0, action);
    assert.ok(f.transport.calls.some(call => call.command === "runtime_stop" && call.args.request.trackingId === "late"));
    await f.gateway.dispose();
  }
});
test("外部から停止・runtime切替・ページ離脱が起きてもカメラと送信を解放する", async () => {
  for (const action of ["stop", "runtime", "unload", "reconnect"]) {
    const f = captureSetup(); const unloads = new Set();
    f.environment.onUnload = callback => { unloads.add(callback); return () => unloads.delete(callback); };
    await f.gateway.connect(() => {}); await f.gateway.start(startInput);
    if (action === "stop") f.transport.emit(snapshot(3));
    if (action === "runtime") {
      f.transport.handler = async () => success(snapshot(0, "new-runtime"));
      f.environment.resume(); await flush();
    }
    if (action === "unload") { for (const callback of unloads) callback(); await flush(); }
    if (action === "reconnect") await f.gateway.connect(() => {});
    assert.equal(f.camera.stops, 1, action); assert.equal(await f.camera.starts[0].submit({}), false);
    await f.gateway.dispose(); assert.equal(unloads.size, 0);
  }
});
test("通常モードの手動開始を拒否し、demoでは手動ソースだけを起動する", async () => {
  const f = captureSetup(); await f.gateway.connect(() => {}); const before = f.transport.calls.length;
  assert.equal((await f.gateway.startManual(startInput)).error.code, "permissionDenied"); assert.equal(f.transport.calls.length, before);
  const result = await f.gateway.startManual({ ...startInput, profile: "demo" }); assert.equal(result.ok, true);
  assert.equal(f.manual.starts.length, 1); assert.equal(f.camera.starts.length, 0);
  f.gateway.setManualFaceDetected(true); assert.equal(f.manual.detected, true);
  await f.gateway.dispose(); assert.equal(f.manual.stops, 1);
});

test("統合したYes／NoをAppControllerから実GatewayのIPC契約へ渡し、完成イベントからカードを表示する", async () => {
  const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
  for (const answer of ["yes", "no"]) {
    const backend = new MockGateway(); backend.loadScenario("reminder");
    const original = backend.getSnapshot();
    const { gateway, transport } = setup();
    transport.handler = (command, args) => {
      if (command === "app_get_snapshot") return success(backend.getSnapshot());
      if (command === "reminder_respond") return backend.respond(args.request);
      if (command === "report_list") return backend.listReports(args.request);
      if (command === "report_get") return backend.getReport(args.request.reportId);
      if (command === "runtime_stop") return backend.stop(args.request.trackingId);
      return failure();
    };
    const controller = new AppController(gateway); await controller.connect();
    await controller.actions.answer(answer);
    const request = transport.calls.find(call => call.command === "reminder_respond").args.request;
    assert.deepEqual(request, { requestId: "request-1", trackingId: original.runtime.trackingId,
      sessionId: original.reminder.sessionId, reminderId: original.reminder.id, answer });
    assert.equal(controller.getState().snapshot.presence.value, "present");
    assert.equal(controller.getState().snapshot.jobs.length, answer === "yes" ? 1 : 0);
    backend.advanceBy(2_000); transport.emit(backend.getSnapshot()); await flush();
    assert.equal(controller.getState().report.phase, answer === "yes" ? "ready" : "closed");
    if (answer === "yes") assert.equal(controller.getState().report.report.trigger, "yes");
    await controller.dispose();
  }
});
