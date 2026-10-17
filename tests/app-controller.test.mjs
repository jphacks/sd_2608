import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, flush, deferred } from "./helpers.mjs";

const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
const { AppController } = await fromBuild("application/AppController.js");
const { createSnapshot, createReport, MINUTE } = await fromBuild("contracts/fixtures.js");

test("初回接続では過去カードを勝手に開かず、ペットから再表示できる", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("reportReady");
  const controller = new AppController(gateway); await controller.connect();
  assert.equal(controller.getState().report.phase, "closed");
  await controller.actions.openLatestReport();
  assert.equal(controller.getState().report.phase, "ready");
});

test("離席中にも完成カードを即表示し、帰席を待たない", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  await controller.connect(); gateway.loadScenario("awayScheduled");
  gateway.advanceBy(5 * MINUTE + 2_000); await flush();
  assert.equal(controller.getState().snapshot.presence.value, "away");
  assert.equal(controller.getState().report.phase, "ready");
});

test("複数完成を順に表示し、同じスナップショットで重複表示しない", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  await controller.connect(); gateway.loadScenario("multipleReports"); await flush();
  const first = controller.getState().report.report.id;
  assert.equal(controller.getState().queuedReportCount, 1);
  controller.actions.closeReport(); await flush();
  assert.notEqual(controller.getState().report.report.id, first);
  assert.equal(controller.getState().queuedReportCount, 0);
  controller.actions.closeReport(); gateway.advanceBy(0); await flush();
  assert.equal(controller.getState().report.phase, "closed");
});

test("削除前に開始したカード読込が遅れても復活しない", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  await controller.connect();
  const pending = deferred(); gateway.getReport = () => pending.promise;
  const reading = controller.actions.openReport("old-report");
  await controller.actions.clearData();
  pending.resolve({ ok: true, data: createReport("old-report") }); await reading;
  assert.equal(controller.getState().report.phase, "closed");
  assert.deepEqual(controller.getState().reportList, []);
});

test("停止中の古い非同期完了と旧 revision は新状態を巻き戻さない", async () => {
  let listener;
  const base = new MockGateway();
  base.connect = async callback => { listener = callback; return createSnapshot(); };
  const controller = new AppController(base); await controller.connect();
  listener({ ...createSnapshot(), revision: 5 });
  listener({ ...createSnapshot(), revision: 2 });
  assert.equal(controller.getState().snapshot.revision, 5);
  const pending = deferred(); base.start = () => pending.promise;
  const starting = controller.actions.start({});
  listener({ ...createSnapshot(), runtimeId: "new-runtime", revision: 1 });
  pending.resolve({ ok: true, data: { ...createSnapshot(), revision: 10 } }); await starting;
  assert.equal(controller.getState().snapshot.runtimeId, "new-runtime");
});

test("StrictMode 相当の接続・解放・再接続で古い接続結果を適用しない", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  const first = controller.connect();
  const disposing = controller.dispose();
  const second = controller.connect();
  await Promise.all([first, disposing, second]);
  gateway.loadScenario("reminder");
  assert.equal(controller.getState().connection, "connected");
  assert.ok(controller.getState().bubble);
});

test("カード取得失敗を表示し、閉じた後は次の完成カードへ進む", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  await controller.connect(); await controller.actions.openReport("not-found");
  assert.equal(controller.getState().report.phase, "error");
  gateway.loadScenario("reportReady"); await flush();
  assert.equal(controller.getState().queuedReportCount, 1);
  controller.actions.closeReport(); await flush();
  assert.equal(controller.getState().report.phase, "ready");
});

test("明示的な再試行の完了で、同じカードを新しい内容へ更新する", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  await controller.connect(); gateway.loadScenario("reportFailed"); await flush();
  assert.equal(controller.getState().report.report.status, "failed");
  await controller.actions.retryReport(); gateway.advanceBy(2_000); await flush();
  assert.equal(controller.getState().report.report.status, "ready");
  assert.equal(controller.getState().report.report.attempt, 2);
});
