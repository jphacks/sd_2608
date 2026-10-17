import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild } from "./helpers.mjs";
const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
const { AppController } = await fromBuild("application/AppController.js");
const MINUTE = 60_000;

async function setup(profile = "normal") {
  const gateway = new MockGateway(), controller = new AppController(gateway);
  await controller.connect();
  await controller.actions.start({ profile, expectedSettingsRevision: 0, reportMode: "local",
    consent: { activity: true, history: true, externalReport: false } });
  return { gateway, controller };
}

test("通常27分・デモ27秒で予告し、30分・30秒で消えて既存の提案へ進む", async () => {
  for (const [profile, unit, label] of [["normal", MINUTE, "分"], ["demo", 1000, "秒"]]) {
    const { gateway, controller } = await setup(profile);
    try {
      gateway.advanceBy(27 * unit - 1);
      assert.equal(controller.getState().advanceNotice, null);
      gateway.advanceBy(1);
      assert.match(controller.getState().advanceNotice.text, new RegExp(`あと3${label}`));
      assert.equal(controller.getState().bubble, null);
      gateway.detectBoundary(); // 予告中は Yes / No を出さない
      assert.equal(controller.getState().bubble, null);
      gateway.advanceBy(unit);
      assert.match(controller.getState().advanceNotice.text, new RegExp(`あと2${label}`));
      gateway.advanceBy(2 * unit);
      assert.equal(controller.getState().advanceNotice, null);
      assert.equal(controller.getState().bubble, null);
      gateway.detectBoundary();
      assert.ok(controller.getState().bubble);
      assert.equal(gateway.getSnapshot().jobs.length, 0);
    } finally { await controller.dispose(); }
  }
});

test("閉じる操作は通信・在席・提案時刻・レポートを変更せず、同じサイクルで再表示しない", async () => {
  const { gateway, controller } = await setup();
  try {
    gateway.advanceBy(27 * MINUTE);
    const before = gateway.getSnapshot(), motion = controller.getState().motion;
    controller.actions.dismissAdvanceNotice();
    assert.deepEqual(gateway.getSnapshot(), before);
    assert.equal(controller.getState().advanceNotice, null);
    assert.equal(controller.getState().motion, motion); // 予告に強い演出を追加しない
    gateway.advanceBy(MINUTE);
    assert.equal(controller.getState().advanceNotice, null);
    await controller.connect(); // 同じ監視への再接続でも閉じた予告を復活させない
    assert.equal(controller.getState().advanceNotice, null);
    gateway.advanceBy(7 * MINUTE);
    assert.equal(controller.getState().bubble.emphasis, "normal");
    assert.equal(gateway.getSnapshot().jobs.length, 0);
    assert.equal(gateway.getSnapshot().session.id, before.session.id);
    assert.equal(gateway.getSnapshot().session.elapsedMs, 35 * MINUTE);
  } finally { await controller.dispose(); }
});

test("在席不確実・停止で隠し、閉じた予告は一時欠落からの復帰で再表示しない", async () => {
  const { gateway, controller } = await setup("demo");
  try {
    gateway.advanceBy(27_000);
    gateway.setPresence("uncertain"); assert.equal(controller.getState().advanceNotice, null);
    gateway.setPresence("present"); assert.ok(controller.getState().advanceNotice);
    controller.actions.dismissAdvanceNotice();
    gateway.setPresence("uncertain"); gateway.setPresence("present");
    assert.equal(controller.getState().advanceNotice, null);
    await controller.actions.stop();
    assert.equal(controller.getState().advanceNotice, null);
    await controller.actions.start({ profile: "demo", expectedSettingsRevision: 0, reportMode: "local",
      consent: { activity: true, history: true, externalReport: false } });
    gateway.advanceBy(27_000); assert.ok(controller.getState().advanceNotice);
  } finally { await controller.dispose(); }
});

test("観測中断後の新しい在席サイクルでは予告を再度表示し、開始直後には持ち越さない", async () => {
  const { gateway, controller } = await setup("demo");
  try {
    gateway.advanceBy(27_000);
    const first = controller.getState().advanceNotice.sessionId;
    controller.actions.dismissAdvanceNotice();
    gateway.setPresence("unknown"); assert.equal(controller.getState().advanceNotice, null);
    gateway.setPresence("present"); assert.equal(controller.getState().advanceNotice, null);
    gateway.advanceBy(27_000);
    assert.notEqual(controller.getState().advanceNotice.sessionId, first);
  } finally { await controller.dispose(); }
});
