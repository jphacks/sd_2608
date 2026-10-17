import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, answerInput } from "./helpers.mjs";

const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
const { scenarios, createSnapshot, MINUTE } = await fromBuild("contracts/fixtures.js");

test("全シナリオは独立した共通型の状態を返す", async () => {
  const gateway = new MockGateway();
  let lastRevision = 0;
  for (const scenario of scenarios) {
    gateway.loadScenario(scenario.id);
    const snapshot = gateway.getSnapshot();
    assert.equal(snapshot.apiVersion, 1);
    assert.ok(snapshot.revision > lastRevision);
    lastRevision = snapshot.revision;
    snapshot.settings.excludedApps.push("mutated");
    assert.deepEqual(gateway.getSnapshot().settings.excludedApps, []);
  }
  const a = createSnapshot(); const b = createSnapshot();
  a.jobs.push({ id: "mutated" });
  assert.equal(b.jobs.length, 0);
});

test("初回は30分から区切りを受け付け、区切りがなくても35分で提案する", () => {
  const gateway = new MockGateway(); gateway.loadScenario("working");
  gateway.detectBoundary(); assert.equal(gateway.getSnapshot().reminder, null);
  gateway.advanceBy(MINUTE); gateway.detectBoundary();
  assert.equal(gateway.getSnapshot().reminder.cause, "boundary");
  gateway.loadScenario("working"); gateway.advanceBy(6 * MINUTE);
  assert.equal(gateway.getSnapshot().reminder.cause, "initialLimit");
});

test("No はレポートを作らず、2分後の新しい区切りで再通知する", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("reminder");
  const input = answerInput(gateway.getSnapshot(), "no");
  assert.equal((await gateway.respond(input)).ok, true);
  gateway.detectBoundary();
  assert.equal(gateway.getSnapshot().reminder, null);
  gateway.advanceBy(2 * MINUTE);
  gateway.detectBoundary();
  assert.ok(gateway.getSnapshot().reminder);
  assert.equal(gateway.getSnapshot().jobs.length, 0);
  assert.equal((await gateway.respond(input)).error.code, "staleReminder");
});

test("No 後の10分上限と60分の強制再通知、5分の再通知間隔", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("reminder");
  await gateway.respond(answerInput(gateway.getSnapshot(), "no"));
  gateway.advanceBy(10 * MINUTE);
  assert.ok(gateway.getSnapshot().reminder);
  gateway.advanceBy(19 * MINUTE); // 連続在席59分で No、通常期限は69分
  await gateway.respond(answerInput(gateway.getSnapshot(), "no"));
  gateway.advanceBy(MINUTE);
  assert.equal(gateway.getSnapshot().reminder.level, "hard");
  await gateway.respond(answerInput(gateway.getSnapshot(), "no"));
  gateway.advanceBy(5 * MINUTE - 1);
  assert.equal(gateway.getSnapshot().reminder, null);
  gateway.advanceBy(1);
  assert.equal(gateway.getSnapshot().reminder.level, "hard");
});

test("Yes と離席が重なってもジョブを増やさず、Yes 直後の起立も断定しない", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("reminder");
  const input = answerInput(gateway.getSnapshot(), "yes");
  const result = await gateway.respond(input);
  assert.ok(result.data.reportId);
  assert.equal(gateway.getSnapshot().presence.value, "present");
  gateway.setPresence("away");
  assert.equal(gateway.getSnapshot().jobs.length, 1);
  assert.equal(gateway.getSnapshot().jobs[0].trigger, "yes");
  assert.equal((await gateway.respond(input)).ok, false);
});

test("離席予約は帰席後も残り、旧セッションの固定履歴で生成する", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("awayScheduled");
  const old = gateway.getSnapshot(); const job = old.jobs[0];
  gateway.setPresence("present");
  assert.notEqual(gateway.getSnapshot().session.id, job.sessionId);
  gateway.advanceBy(5 * MINUTE - 1);
  assert.equal(gateway.getSnapshot().jobs[0].status, "scheduled");
  gateway.advanceBy(2_001);
  const result = await gateway.getReport(job.id);
  assert.equal(result.ok, true);
  assert.equal(result.data.sessionId, job.sessionId);
  assert.equal(result.data.history.rangeEnd, old.emittedAt);
});

test("停止・削除後に予約や実行中ジョブを復活させない", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("generating");
  const id = gateway.getSnapshot().jobs[0].id;
  await gateway.stop(gateway.getSnapshot().runtime.trackingId);
  gateway.advanceBy(10 * MINUTE);
  assert.equal(gateway.getSnapshot().jobs[0].status, "cancelled");
  assert.equal((await gateway.getReport(id)).ok, false);
  await gateway.clearData();
  assert.equal((await gateway.listReports({ cursor: null, limit: 20 })).data.items.length, 0);
});

test("失敗カードの再試行は同じ ID と履歴を保ち、試行番号を増やす", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("reportFailed");
  const job = gateway.getSnapshot().jobs[0];
  const before = (await gateway.getReport(job.id)).data;
  assert.equal((await gateway.retryReport({ reportId: job.id, expectedAttempt: 1 })).ok, true);
  assert.equal((await gateway.retryReport({ reportId: job.id, expectedAttempt: 1 })).ok, false);
  gateway.advanceBy(2_000);
  const after = (await gateway.getReport(job.id)).data;
  assert.equal(after.id, before.id);
  assert.equal(after.attempt, 2);
  assert.equal(after.status, "ready");
  assert.deepEqual(after.history, before.history);
});

test("設定の競合を拒否し、入力キーを状態へ保存しない", async () => {
  const gateway = new MockGateway();
  const settings = gateway.getSnapshot().settings;
  const request = { expectedSettingsRevision: 0, values: { ...settings, reportMode: "ai",
    provider: { kind: "openAiCompatible", endpoint: "https://example.invalid/api", model: "mock" } },
    keyChange: { kind: "replace", value: "test-only-secret-value" } };
  assert.equal((await gateway.updateSettings(request)).ok, true);
  assert.equal(gateway.getSnapshot().settings.hasApiKey, true);
  assert.equal(JSON.stringify(gateway.getSnapshot()).includes("test-only-secret-value"), false);
  assert.equal((await gateway.updateSettings(request)).error.code, "staleRevision");
});

test("履歴なし・ローカルカードと一覧のページングを扱える", async () => {
  const gateway = new MockGateway(); gateway.loadScenario("emptyReport");
  const empty = (await gateway.getReport(gateway.getSnapshot().jobs[0].id)).data;
  assert.equal(empty.status, "local"); assert.equal(empty.history.segments.length, 0);
  gateway.loadScenario("multipleReports");
  const page = (await gateway.listReports({ cursor: null, limit: 1 })).data;
  const next = (await gateway.listReports({ cursor: page.nextCursor, limit: 1 })).data;
  assert.notEqual(page.items[0].id, next.items[0].id);
  assert.equal(next.nextCursor, null);
});
