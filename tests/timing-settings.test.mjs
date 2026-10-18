import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, answerInput } from "./helpers.mjs";
const { createTimingProfiles, timingKeys, validateTimingProfiles } = await fromBuild("contracts/timings.js");
const { createSnapshot } = await fromBuild("contracts/fixtures.js");
const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
const { AppController } = await fromBuild("application/AppController.js");
const { decodeCommandResult, DecodeError } = await fromBuild("adapters/tauri/decode.js");
const { formatDuration, timingFields } = await fromBuild("presentation/timingSettings.js");

test("通常・デモの初期値は従来どおりで、設定オブジェクトを共有しない", () => {
  const first = createTimingProfiles(), second = createTimingProfiles();
  assert.deepEqual(Object.values(first.normal), [30_000, 300_000, 1_800_000, 180_000, 2_100_000, 600_000, 120_000, 3_600_000, 300_000, 600_000, 5_000, 10_000, 2_000]);
  assert.deepEqual(Object.values(first.demo), [5_000, 5_000, 30_000, 3_000, 35_000, 10_000, 2_000, 60_000, 5_000, 10_000, 2_000, 5_000, 1_000]);
  assert.deepEqual(timingFields.map(field => field.key).sort(), [...timingKeys].sort());
  first.normal.firstMs = 1_000;
  assert.equal(second.normal.firstMs, 1_800_000);
  assert.equal(first.demo.firstMs, 30_000);
});

test("不正な時間・順序をUI側とIPC Decoderで拒否する", () => {
  for (const profile of ["normal", "demo"]) {
    for (const [key, value] of [["firstMs", 0], ["idleMs", -1], ["idleMs", 1_500], ["reportDelayMs", 86_401_000],
      ["advanceNoticeLeadMs", 86_400_000], ["firstMs", 86_400_000], ["firstLimitMs", 86_400_000],
      ["cooldownMs", 86_400_000], ["switchIdleMs", 86_400_000], ["snoozeMs", NaN]]) {
      const snapshot = createSnapshot(); snapshot.settings.timings[profile][key] = value;
      assert.ok(validateTimingProfiles(snapshot.settings.timings), `${profile}.${key}`);
      assert.throws(() => decodeCommandResult("app_get_snapshot", { ok: true, data: snapshot }), DecodeError);
    }
  }
  const profiles = createTimingProfiles();
  Object.assign(profiles.demo, { advanceNoticeLeadMs: 0, reportDelayMs: 0, cooldownMs: 0, yesGraceMs: 0 });
  assert.equal(validateTimingProfiles(profiles), null);
});

async function setup(profile) {
  const gateway = new MockGateway();
  const controller = new AppController(gateway);
  await controller.connect();
  const values = controller.getState().snapshot.settings;
  Object.assign(values.timings.normal, { firstMs: 240_000, advanceNoticeLeadMs: 125_000, firstLimitMs: 260_000, hardMs: 600_000 });
  Object.assign(values.timings.demo, { firstMs: 12_000, advanceNoticeLeadMs: 4_000, firstLimitMs: 16_000,
    hardMs: 60_000, cooldownMs: 3_000, snoozeMs: 7_000, yesGraceMs: 5_000, reportDelayMs: 9_000 });
  await controller.actions.saveSettings({ expectedSettingsRevision: 0, values, keyChange: { kind: "keep" } });
  await controller.actions.start({ profile, expectedSettingsRevision: 1, reportMode: "local",
    consent: { activity: true, history: true, externalReport: false } });
  return { gateway, controller };
}

test("選択した版の予告・初回上限を使い、通常版でも分と秒を正確に案内する", async () => {
  for (const profile of ["normal", "demo"]) {
    const { gateway, controller } = await setup(profile);
    try {
      const timings = gateway.getSnapshot().settings.timings[profile];
      gateway.advanceBy(timings.firstMs - timings.advanceNoticeLeadMs - 1);
      assert.equal(controller.getState().advanceNotice, null);
      gateway.advanceBy(1);
      assert.match(controller.getState().advanceNotice.text, profile === "normal" ? /あと2分5秒/ : /あと4秒/);
      gateway.advanceBy(timings.advanceNoticeLeadMs + timings.firstLimitMs - timings.firstMs - 1);
      assert.equal(controller.getState().bubble, null);
      gateway.advanceBy(1);
      assert.equal(controller.getState().snapshot.reminder.cause, "initialLimit");
    } finally { await controller.dispose(); }
  }
});

test("設定した再通知・作成後の猶予・離席後のレポート待ち時間をモックにも適用する", async () => {
  const { gateway, controller } = await setup("demo");
  try {
    gateway.advanceBy(16_000);
    await gateway.respond(answerInput(gateway.getSnapshot(), "no"));
    gateway.advanceBy(6_999); assert.equal(gateway.getSnapshot().reminder, null);
    gateway.advanceBy(1); assert.equal(gateway.getSnapshot().reminder.cause, "snoozeLimit");
    await gateway.respond(answerInput(gateway.getSnapshot(), "yes"));
    gateway.advanceBy(4_999); assert.equal(gateway.getSnapshot().reminder, null);
    gateway.advanceBy(1); assert.ok(gateway.getSnapshot().reminder);
    gateway.setPresence("away"); gateway.setPresence("present"); gateway.setPresence("away");
    const job = gateway.getSnapshot().jobs.at(-1);
    assert.equal(job.dueAt - job.requestedAt, 9_000);
  } finally { await controller.dispose(); }
});

test("時間の表示は0秒・分秒・時間に対応する", () => {
  assert.equal(formatDuration(0), "0秒");
  assert.equal(formatDuration(125_000), "2分5秒");
  assert.equal(formatDuration(3_600_000), "1時間");
});
