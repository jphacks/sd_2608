import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fromBuild } from "./helpers.mjs";
const { animationSpec, frameAt, moveTo, initialMotion, finishMotion } = await fromBuild("pochi/animation.js");

test("全107フレームの順序・時間と逆再生が一致し、1回動作を確実に終了する", () => {
  const expected = { idle:[8,3600], reminder:[8,1440], rest:[14,4200], record:[8,1760], welcome:[20,2710], turn_sit:[23,3320], rest_to_sit:[26,2530] };
  let count = 0;
  for (const [name,[n,total]] of Object.entries(expected)) {
    const spec = animationSpec(name); count += spec.count;
    assert.equal(spec.count,n); assert.equal(spec.durations.reduce((a,b)=>a+b),total);
    const png=fs.readFileSync(`public${spec.src}`);
    assert.equal(png.readUInt32BE(16),spec.columns*512); assert.equal(png.readUInt32BE(20),spec.rows*512);
    assert.equal(frameAt(name,total).done,!spec.loop);
  }
  assert.equal(count,107);
  const rise=animationSpec("rest_to_sit"), down=animationSpec("sit_to_rest");
  assert.deepEqual(down.frames,[...rise.frames].reverse()); assert.deepEqual(down.durations,[...rise.durations].reverse());
  assert.equal(frameAt("sit_to_rest",2530).done,true);
});

test("姿勢遷移の割り込みは現在の遷移を完了し、古い再生トークンを無視する", () => {
  const rise=moveTo({...initialMotion(),id:"rest"},"idle","reminder");
  const interrupted=moveTo(rise,"rest");
  assert.equal(interrupted.token,rise.token); assert.deepEqual(interrupted.queue,["sit_to_rest"]);
  const down=finishMotion(interrupted,rise.token); assert.equal(down.id,"sit_to_rest");
  assert.equal(finishMotion(down,rise.token),down); assert.equal(finishMotion(down,down.token).id,"rest");
});
