import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fromBuild, flush } from "./helpers.mjs";

const { BrowserNotificationAudio } = await fromBuild("adapters/audio/BrowserNotificationAudio.js");
const { AppController } = await fromBuild("application/AppController.js");
const { MockGateway } = await fromBuild("adapters/mock/MockGateway.js");
const { createSnapshot } = await fromBuild("contracts/fixtures.js");
const { decodeCommandResult, DecodeError } = await fromBuild("adapters/tauri/decode.js");

test("2種類の同梱素材を再生し、切替・音なし・終了で前の音を止める", () => {
  const players = [];
  const audio = new BrowserNotificationAudio(source => {
    assert.ok(fs.statSync(new URL(`../public${source}`, import.meta.url)).size > 0);
    const player = { source, currentTime: 1, plays: 0, pauses: 0,
      play() { this.plays++; return Promise.resolve(); }, pause() { this.pauses++; } };
    players.push(player); return player;
  });
  audio.play("dog");
  assert.equal(players[0].source, "/sounds/dog.mp3");
  assert.equal(players[0].plays, 1);
  audio.play("system");
  assert.equal(players[0].pauses, 1);
  assert.equal(players[0].currentTime, 0);
  assert.equal(players[1].source, "/sounds/system.mp3");
  audio.play("none");
  assert.equal(players.length, 2);
  assert.equal(players[1].pauses, 1);
  audio.play("dog"); audio.stop();
  assert.equal(players[2].pauses, 1);
});

test("再生失敗と遅れて届く拒否が後続の通知を壊さない", async () => {
  let reject;
  const players = [];
  const audio = new BrowserNotificationAudio(() => {
    const player = { currentTime: 0, pauses: 0, pause() { this.pauses++; },
      play: () => players.length === 1 ? new Promise((_, fail) => { reject = fail; }) : Promise.resolve() };
    players.push(player); return player;
  });
  audio.play("dog"); audio.play("system"); reject(new Error("blocked")); await flush();
  assert.equal(players[1].pauses, 0);
  const rejected = new BrowserNotificationAudio(() => ({ currentTime: 0, pause() {}, play: () => Promise.reject(Error("blocked")) }));
  rejected.play("dog"); await flush();
  assert.doesNotThrow(() => new BrowserNotificationAudio(() => { throw Error("unavailable"); }).play("dog"));
});

async function setup(sound = "dog") {
  const played = [], gateway = new MockGateway();
  let stops = 0;
  const controller = new AppController(gateway, { play: sound => played.push(sound), stop: () => { stops++; } });
  await controller.connect();
  await controller.actions.saveSettings({ expectedSettingsRevision: 0,
    values: { ...controller.getState().snapshot.settings, notificationSound: sound }, keyChange: { kind: "keep" } });
  await controller.actions.start({ profile: "demo", expectedSettingsRevision: 1, reportMode: "local",
    consent: { activity: true, history: true, externalReport: false } });
  return { gateway, controller, played, stops: () => stops };
}

test("予告・提案・再通知・レポート完了で選択した音を一度ずつ鳴らす", async () => {
  const { gateway, controller, played, stops } = await setup("system");
  try {
    assert.deepEqual(played, []);
    gateway.advanceBy(27_000); assert.deepEqual(played, ["system"]);
    gateway.advanceBy(1_000); gateway.setPresence("uncertain"); gateway.setPresence("present");
    assert.deepEqual(played, ["system"]);
    gateway.advanceBy(2_000); gateway.detectBoundary();
    assert.deepEqual(played, ["system", "system"]);
    gateway.advanceBy(1_000);
    await controller.actions.answer("no");
    gateway.advanceBy(10_000);
    assert.deepEqual(played, ["system", "system", "system"]);
    await controller.actions.answer("yes");
    gateway.advanceBy(2_000); await flush();
    assert.deepEqual(played, ["system", "system", "system", "system"]);
    controller.actions.closeReport(); await controller.actions.openLatestReport();
    gateway.advanceBy(1_000); assert.equal(played.length, 4);
  } finally { const before = stops(); await controller.dispose(); assert.ok(stops() > before); }
});

test("音なしへの切替も通知を維持し、新しい監視には現在の設定を使う", async () => {
  const { gateway, controller, played } = await setup("none");
  try {
    gateway.advanceBy(27_000);
    assert.ok(controller.getState().advanceNotice);
    assert.deepEqual(played, ["none"]);
    await controller.actions.stop();
    const settings = controller.getState().snapshot.settings;
    await controller.actions.saveSettings({ expectedSettingsRevision: settings.revision,
      values: { ...settings, notificationSound: "dog" }, keyChange: { kind: "keep" } });
    await controller.actions.start({ profile: "demo", expectedSettingsRevision: settings.revision + 1, reportMode: "local",
      consent: { activity: true, history: true, externalReport: false } });
    gateway.advanceBy(27_000);
    assert.deepEqual(played, ["none", "dog"]);
  } finally { await controller.dispose(); }
});

test("既存通知での初回接続・再接続・古い状態・バックエンド再起動は鳴らさない", async () => {
  const gateway = new MockGateway(), played = [];
  gateway.loadScenario("reminder");
  const controller = new AppController(gateway, { play: sound => played.push(sound), stop() {} });
  try {
    await controller.connect(); await controller.connect();
    assert.deepEqual(played, []);
    gateway.advanceBy(1_000); assert.deepEqual(played, []);
  } finally { await controller.dispose(); }
  let receive;
  const base = createSnapshot();
  gateway.connect = async listener => { receive = listener; return base; };
  const second = new AppController(gateway, { play: sound => played.push(sound), stop() {} });
  try {
    await second.connect();
    const initial = createSnapshot(); initial.runtimeId = "new-runtime"; initial.revision = 10;
    initial.reminder = { id: "existing-reminder" };
    receive(initial);
    receive({ ...initial, revision: 9, reminder: { id: "stale-reminder" } });
    receive({ ...initial, revision: 11 });
    assert.deepEqual(played, []);
  } finally { await second.dispose(); }
});

test("通知音の IPC 契約は3択だけを受け付ける", () => {
  for (const sound of ["dog", "system", "none", "invalid", null]) {
    const snapshot = createSnapshot(); snapshot.settings.notificationSound = sound;
    const decode = () => decodeCommandResult("app_get_snapshot", { ok: true, data: snapshot });
    if (["dog", "system", "none"].includes(sound)) assert.equal(decode().data.settings.notificationSound, sound);
    else assert.throws(decode, DecodeError);
  }
});
