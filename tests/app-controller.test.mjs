import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, flush, deferred } from "./helpers.mjs";

const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
const { AppController } = await fromBuild("application/AppController.js");
const { createSnapshot, createReport, createJob, MINUTE } = await fromBuild("contracts/fixtures.js");

test("離席から安定化中を経た帰席で一度だけあいさつし、unknownでは帰席待ちを解除する", async () => {
  for (const intermediate of ["uncertain", "unknown"]) {
    const gateway = new MockGateway(); let receive;
    gateway.connect = async callback => { receive = callback; return createSnapshot(); };
    const controller = new AppController(gateway); await controller.connect();
    const state = (value, revision) => { const snapshot = createSnapshot(); snapshot.revision = revision; snapshot.runtime.phase = "running";
      snapshot.presence.value = value; return snapshot; };
    receive(state("away", 1)); receive(state(intermediate, 2)); receive(state("present", 3));
    assert.equal(controller.getState().pet.greeting, intermediate === "uncertain" ? "おかえりなさい！" : null);
    receive(state("present", 4)); assert.equal(controller.getState().pet.greeting, null);
    await controller.dispose();
  }
});

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
test("再試行の応答より先にローカル生成が完了しても読み込み中へ戻さない", async () => {
  const gateway = new MockGateway(); const controller = new AppController(gateway);
  await controller.connect(); gateway.loadScenario("reportFailed"); await flush();
  const retry = gateway.retryReport.bind(gateway);
  gateway.retryReport = async input => {
    const accepted = structuredClone(await retry(input));
    gateway.advanceBy(2_000); await flush();
    return accepted;
  };
  await controller.actions.retryReport(); await flush();
  assert.equal(controller.getState().report.phase, "ready");
  assert.equal(controller.getState().report.report.attempt, 2);
});
test("Yesの応答より先に完成しても表示中の別カードを上書きしない", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("reminder");
  const initial = gateway.getSnapshot();
  const old = createReport("previous-report", "previous-session");
  const next = createReport("new-report", initial.session.id);
  const oldJob = { ...createJob(old, "ready"), completionSeq: 1 };
  initial.jobs = [oldJob]; initial.completionSeq = 1;
  let receive;
  gateway.connect = async callback => { receive = callback; return structuredClone(initial); };
  gateway.listReports = async () => ({ ok: true, data: { items: [], nextCursor: null } });
  gateway.getReport = async id => ({ ok: true, data: id === old.id ? old : next });
  gateway.respond = async () => {
    const accepted = structuredClone(initial); accepted.revision++; accepted.reminder = null;
    accepted.session.reportJobId = next.id; accepted.jobs.push(createJob(next, "queued"));
    const completed = structuredClone(accepted); completed.revision++; completed.completionSeq = 2;
    completed.jobs[1] = { ...completed.jobs[1], status: "ready", completionSeq: 2 };
    receive(completed); await flush();
    return { ok: true, data: { snapshot: accepted, reportId: next.id } };
  };
  const controller = new AppController(gateway); await controller.connect();
  await controller.actions.openReport(old.id); await controller.actions.answer("yes"); await flush();
  assert.equal(controller.getState().report.report.id, old.id);
  assert.equal(controller.getState().queuedReportCount, 1);
  controller.actions.closeReport(); await flush();
  assert.equal(controller.getState().report.report.id, next.id);
});

test("初期バッファの別 runtime を revision 順に並べず、退役した状態を復活させない", async () => {
  const gateway = new MockGateway(); let listener;
  const current = { ...createSnapshot(), runtimeId: "restarted", revision: 1 };
  gateway.connect = async callback => {
    listener = callback;
    callback({ ...createSnapshot(), revision: 90 });
    callback(current);
    return current;
  };
  const controller = new AppController(gateway); await controller.connect();
  assert.equal(controller.getState().snapshot.runtimeId, "restarted");
  listener({ ...createSnapshot(), revision: 100 });
  assert.equal(controller.getState().snapshot.runtimeId, "restarted");
});

test("connect の正本取得後に到着した新しい runtime は受信順に採用する", async () => {
  const gateway = new MockGateway();
  gateway.connect = async callback => {
    callback({ ...createSnapshot(), runtimeId: "restarted", revision: 1 });
    callback({ ...createSnapshot(), runtimeId: "restarted", revision: 2 });
    return { ...createSnapshot(), revision: 80 };
  };
  const controller = new AppController(gateway); await controller.connect();
  assert.equal(controller.getState().snapshot.runtimeId, "restarted");
  assert.equal(controller.getState().snapshot.revision, 2);
});
