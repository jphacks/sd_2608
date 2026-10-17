import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fromBuild } from "./helpers.mjs";

const { decodeCommandResult, faceInputDecoder, DecodeError } = await fromBuild("adapters/tauri/decode.js");
const { createSnapshot } = await fromBuild("contracts/fixtures.js");
const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/ipc/cases.json", import.meta.url), "utf8"));
const commands = { snapshot: "app_get_snapshot", report: "report_get", page: "report_list", faceReceipt: "face_submit", respond: "reminder_respond" };
for (const fixture of cases) {
  test(`Rust 共通 IPC ケース：${fixture.name}`, () => {
    const decode = () => fixture.kind === "faceInput" ? faceInputDecoder(fixture.value) : decodeCommandResult(commands[fixture.kind], fixture.value);
    if (fixture.valid) assert.deepEqual(decode(), fixture.value);
    else assert.throws(decode, DecodeError);
  });
}
test("Rust の初期状態用 fixture は既存の UI fixture と一致する", () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL("./fixtures/ipc/snapshot.json", import.meta.url), "utf8"));
  assert.deepEqual(snapshot, { ...createSnapshot(snapshot.emittedAt), runtimeId: snapshot.runtimeId });
});
