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
function setup() { const transport = new Transport(); const environment = new Environment(); return { transport, environment, gateway: new TauriGateway(transport, environment) }; }

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
