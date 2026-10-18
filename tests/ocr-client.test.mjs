import test from "node:test";
import assert from "node:assert/strict";
import { fromBuild, deferred, flush } from "./helpers.mjs";
const { startOcrClient } = await fromBuild("adapters/ocr/OcrClient.js");
function fixture(recognize) {
  let listener, unlistened = false;
  const calls = [];
  const stop = startOcrClient({ listen: async (_, receive) => { listener = receive; return () => { unlistened = true; }; },
    invoke: async (command, args) => calls.push({ command, args }) }, recognize);
  return { calls, stop, send: value => listener(value), get unlistened() { return unlistened; } };
}
test("依頼された画像をローカルで認識し、画像を返信せず文字だけを返す", async () => {
  const f = fixture(async image => { assert.match(image, /^data:image\/png;base64,/); return "local text"; });
  f.send({ requestId: "ocr-1-0", image: "data:image/png;base64,AA==" }); await flush();
  assert.deepEqual(f.calls, [{ command: "ocr_complete", args: { request: { requestId: "ocr-1-0", text: "local text", failed: false } } }]);
  f.stop(); await flush(); assert.ok(f.unlistened);
});
test("取消・破棄後の遅いOCRを返信せず、新しいウィンドウへ混ぜない", async () => {
  const pending = deferred(); let signal;
  const f = fixture(async (_, s) => { signal = s; return pending.promise; });
  f.send({ requestId: "ocr-1-0", image: "data:image/png;base64,AA==" });
  f.send({ requestId: "ocr-1-0", image: null }); assert.ok(signal.aborted);
  pending.resolve("late private text"); await flush(); assert.deepEqual(f.calls, []);
  f.stop();
});
test("認識エラーの内部情報を返信せず、履歴へフォールバックできる失敗を返す", async () => {
  const f = fixture(async () => { throw Error("private-image-details"); });
  f.send({ requestId: "ocr-1-1", image: "data:image/png;base64,AA==" }); await flush();
  assert.deepEqual(f.calls[0].args.request, { requestId: "ocr-1-1", text: "", failed: true }); f.stop();
});
test("不正な依頼と解除後の依頼を認識せず、遅い購読も解除する", async () => {
  let recognized = 0;
  const f = fixture(async () => { recognized++; return ""; });
  f.send({ requestId: "bad", image: "data:image/png;base64,AA==" });
  f.send({ requestId: "ocr-1-2", image: "https://external.invalid/image.png" });
  f.stop(); f.send({ requestId: "ocr-1-2", image: "data:image/png;base64,AA==" }); await flush();
  assert.equal(recognized, 0); assert.ok(f.unlistened);
});
