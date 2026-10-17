import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fromBuild } from "./helpers.mjs";
const { freshData, reducePochi, restoreData, checkedSettings, settleCards, dataForStorage } = await fromBuild("pochi/model.js");
const { animationSpec, frameAt, moveTo, initialMotion, finishMotion } = await fromBuild("pochi/animation.js");
const { LocalRepository, decodeData } = await fromBuild("pochi/repository.js");
const { PochiController } = await fromBuild("pochi/controller.js");
const start = (data = freshData()) => reducePochi(data, { type: "start", id: "s1", task: "テスト作業", kind: "work", now: 1000 });
const tick = (data, elapsedMs) => reducePochi(data, { type: "tick", elapsedMs, now: data.active.updatedAt + elapsedMs });
test("作業→通知→Yes→メモ→復帰→終了で時間と休憩回数を分離する", () => {
  let d = tick(start(), 30 * 60_000); assert.equal(d.active.phase, "reminder");
  d = reducePochi(d, { type: "yes", now: 1_801_000, reason: "reminder" });
  d = tick(d, 20_000); assert.equal(d.active.workMs, 1_800_000); assert.equal(d.active.restMs, 20_000);
  for (let i = 0; i < 3; i++) d = reducePochi(d, { type: "yes", now: 1_821_000, reason: "manual" });
  d = reducePochi(d, { type: "note", progress: " 実装できた ", problem: "あとで確認", now: 1_821_000 });
  assert.equal(d.active.breaks.length, 1); assert.equal(d.active.breaks[0].progress, " 実装できた ");
  d = reducePochi(d, { type: "return", now: 1_821_000 }); d = tick(d, 5_000);
  d = reducePochi(d, { type: "end", now: 1_826_000 });
  const again = reducePochi(d, { type: "end", now: 1_826_001 });
  assert.equal(again.history.length, 1); assert.equal(d.history[0].workMs, 1_805_000); assert.equal(d.history[0].breaks[0].durationMs, 20_000);
});
test("Noは休憩を増やさず、指定の作業時間が経過したときに再通知する", () => {
  let d = tick(start(), 1_800_000);
  d = reducePochi(d, { type: "no", now: 1_801_000 });
  assert.equal(d.active.breaks.length, 0); assert.equal(d.active.reminders[0].choice, "no");
  d = tick(d, 599_999); assert.equal(d.active.phase, "working");
  d = tick(d, 1); assert.equal(d.active.phase, "reminder"); assert.equal(d.active.reminders.length, 2);
});
test("中断復元では停止中の時間を加算せず、再開と終了を選べる", () => {
  let d = tick(start(), 5_000); d = reducePochi(d, { type: "yes", now: 6000, reason: "manual" }); d = tick(d, 3000);
  d = restoreData(decodeData(JSON.stringify(d))); d = tick(d, 100_000_000);
  assert.equal(d.active.phase, "recovered"); assert.equal(d.active.restMs, 3000);
  d = reducePochi(d, { type: "resume", now: 100_000_000 });
  assert.equal(d.active.breaks[0].endedAt, 9000); assert.equal(d.active.workMs, 5000);
});
test("設定の変更を反映し、不正値と二重開始を拒否する", () => {
  assert.throws(() => checkedSettings({ ...freshData().settings, remindMinutes: NaN }));
  let d = tick(start(), 10_000); assert.equal(start(d), d);
  d = reducePochi(d, { type: "settings", settings: { ...d.settings, remindMinutes: 1 }, now: 11_000 });
  assert.equal(d.active.nextReminderWorkMs, 70_000);
  for (const elapsedMs of [NaN, Infinity, -100, 0]) assert.equal(tick(d, elapsedMs), d);
});
test("全107フレームの順序・時間と逆再生が一致し、1回動作を確実に終了する", () => {
  const expected = { idle: [8,3600], reminder:[8,1440], rest:[14,4200], record:[8,1760], welcome:[20,2710], turn_sit:[23,3320], rest_to_sit:[26,2530] };
  let count = 0;
  for (const [name,[n,total]] of Object.entries(expected)) {
    const spec = animationSpec(name); count += spec.count;
    assert.equal(spec.count,n); assert.equal(spec.durations.reduce((a,b)=>a+b),total);
    assert.ok(fs.existsSync(`public${spec.src}`));
    const png=fs.readFileSync(`public${spec.src}`); assert.equal(png.readUInt32BE(16),spec.columns*512); assert.equal(png.readUInt32BE(20),spec.rows*512);
    assert.equal(frameAt(name,total).done,!spec.loop);
  }
  assert.equal(count,107);
  const rise=animationSpec("rest_to_sit"), down=animationSpec("sit_to_rest");
  assert.deepEqual(down.frames,[...rise.frames].reverse()); assert.deepEqual(down.durations,[...rise.durations].reverse());
  assert.equal(frameAt("sit_to_rest",2530).done,true);
});
test("起き上がり中のYesは姿勢遷移を完了してから伏せ、古い完了通知を無視する", () => {
  const resting={...initialMotion(),id:"rest"};
  const rise=moveTo(resting,"idle","reminder"); assert.equal(rise.id,"rest_to_sit");
  const interrupted=moveTo(rise,"rest"); assert.equal(interrupted.token,rise.token); assert.deepEqual(interrupted.queue,["sit_to_rest"]);
  const down=finishMotion(interrupted,rise.token); assert.equal(down.id,"sit_to_rest");
  assert.equal(finishMotion(down,rise.token),down); assert.equal(finishMotion(down,down.token).id,"rest");
});
function memoryStorage() { const values=new Map(); return { values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k) }; }
test("保存と予備コピーからの復旧、壊れたデータの保護", () => {
  const storage=memoryStorage(), repo=new LocalRepository(storage,"a",()=>1000); repo.load(); repo.save(start()); repo.save(tick(start(),10));
  storage.setItem("pochi.manual.v1","broken"); const restored=new LocalRepository(storage,"a").load();
  assert.equal(restored.data.active.phase,"recovered"); assert.ok(restored.notice);
  storage.setItem("pochi.manual.v1.backup","also broken"); const blocked=new LocalRepository(storage,"a"); blocked.load();
  assert.throws(()=>blocked.save(freshData())); assert.equal(storage.getItem("pochi.manual.v1"),"broken");
});
test("二重起動で別の記録を上書きしない（リース期限後も再読込を要求）", () => {
  const storage=memoryStorage(); let now=1000;
  const first=new LocalRepository(storage,"a",()=>now), second=new LocalRepository(storage,"b",()=>now);
  first.load(); first.save(start()); second.load(); assert.throws(()=>second.save(freshData()),/別のポチ/);
  now+=20_000; assert.throws(()=>second.save(freshData())); assert.ok(decodeData(storage.getItem("pochi.manual.v1")).active);
});
test("コントローラーは休止・スリープを除外し、終了とpagehideでレポートを重複しない", () => {
  let time=1000, saved=freshData(); const repo={load:()=>({data:saved,notice:""}),save:d=>{saved=d;},release:()=>{}};
  const c=new PochiController(repo,{monotonic:()=>time,wall:()=>time},true,()=>"id"); c.mount(); c.setSpeed(1); c.start("demo","study");
  time+=1000;c.tick(); assert.equal(saved.active.workMs,0); // UI ticks; periodic persistence follows.
  assert.equal(c.getSnapshot().data.active.workMs,1000);
  c.setPaused(true);time+=100_000;c.tick();c.setPaused(false);time+=1000;c.tick();
  assert.equal(c.getSnapshot().data.active.workMs,2000);
  time+=1_000_000;c.tick();assert.equal(c.getSnapshot().data.active.workMs,2000);
  c.end(true);c.pageHide();assert.equal(saved.history.length,1);assert.equal(saved.active,null);c.unmount();
});
test("保存に失敗したときはエラーを表示し、保存済みだと見せず終了を止める", () => {
  const repo={load:()=>({data:freshData(),notice:""}),save:()=>{throw new Error("容量不足");},release:()=>{}};
  const c=new PochiController(repo,{monotonic:()=>1000,wall:()=>1000});c.mount();c.start("unsafe","work");
  assert.equal(c.getSnapshot().data.active,null);assert.match(c.getSnapshot().error,/容量不足/);assert.equal(c.end(true),false);
});
test("短縮フローで設定中の通知・即Yes・メモ・歓迎待機・終了をつなげる", () => {
  let time=1000, saved=freshData(), notifications=[];
  const c=new PochiController({load:()=>({data:saved,notice:""}),save:d=>{saved=d;},release:()=>{}},
    {monotonic:()=>time,wall:()=>time},true,()=>"demo",text=>notifications.push(text));
  const finish=()=>c.completeAnimation(c.getSnapshot().motion.token);
  c.mount();c.saveSettings({...saved.settings,remindMinutes:1});c.start("仕様の確認","work");finish();assert.equal(c.getSnapshot().motion.id,"rest");
  c.openSettings();for(let i=0;i<6;i++){time+=2000;c.tick();}
  assert.equal(c.getSnapshot().panel,"settings");assert.equal(c.getSnapshot().data.active.phase,"reminder");assert.equal(notifications.length,1);
  c.closePanel();c.accept();c.accept();assert.equal(c.getSnapshot().data.active.breaks.length,1);
  assert.equal(c.getSnapshot().motion.id,"rest_to_sit");finish();assert.equal(c.getSnapshot().motion.id,"sit_to_rest");finish();
  c.note("前半を確認","後半の相談");time+=2000;c.tick();c.returnToWork();
  assert.equal(c.getSnapshot().panel,"welcome");finish();assert.equal(c.getSnapshot().motion.id,"welcome");finish();assert.equal(c.getSnapshot().motion.id,"idle");
  c.end(true);c.pageHide();assert.equal(saved.history.length,1);assert.equal(saved.history[0].restMs,120000);
  assert.equal(saved.history[0].breaks[0].progress,"前半を確認");c.unmount();
});

test("離席5分後の予約は帰席しても残り、離席前の作業だけをレポートにする", () => {
  let d=tick(start(),10000);
  d=reducePochi(d,{type:"leave",now:11000}); assert.equal(d.active.phase,"away");assert.equal(d.active.breaks.length,0);
  const due=d.cards[0].dueAt;assert.equal(due,311000);
  d=reducePochi(d,{type:"return",now:12000});d=tick(d,20000);
  assert.equal(d.active.workMs,30000);assert.equal(d.cards[0].status,"scheduled");
  d=settleCards(d,due);assert.equal(d.cards[0].status,"generating");
  d=settleCards(d,due+4200);assert.equal(d.cards[0].status,"ready");assert.equal(d.cards[0].session.workMs,10000);
  d=reducePochi(d,{type:"end",now:due+5000});assert.equal(d.cards[0].session.workMs,10000);
});
test("保存オフでは現在の作業と途中レポートを主データ・予備コピーへ残さない", () => {
  let d=start();const storage=memoryStorage(), repo=new LocalRepository(storage,"owner",()=>1000);repo.load();repo.save(d);
  d=reducePochi(d,{type:"yes",now:2000,reason:"manual"});repo.save(d);
  d=reducePochi(d,{type:"settings",now:2000,settings:{...d.settings,saveHistory:false}});repo.save(d);
  assert.equal(decodeData(storage.getItem("pochi.manual.v1")).active,null);
  assert.equal(decodeData(storage.getItem("pochi.manual.v1.backup")).active,null);
  d=reducePochi(d,{type:"end",now:3000});assert.equal(d.history.length,1);assert.equal(dataForStorage(d).history.length,0);assert.equal(dataForStorage(d).cards.length,0);
});
test("記録の旧形式を移行し、離席を休憩時間に含める設定を反映する", () => {
  let d=start();const raw=JSON.parse(JSON.stringify(d));delete raw.cards;delete raw.active.absences;delete raw.active.persisted;
  for(const key of ["saveHistory","cameraDemo","postureDemo","awayCountsAsRest"])delete raw.settings[key];
  d=decodeData(JSON.stringify(raw));assert.equal(d.active.persisted,true);assert.deepEqual(d.cards,[]);
  d=reducePochi(d,{type:"settings",now:1000,settings:{...d.settings,awayCountsAsRest:true}});
  d=reducePochi(d,{type:"leave",now:1000});d=tick(d,5000);assert.equal(d.active.restMs,5000);assert.equal(d.active.workMs,0);assert.equal(d.active.breaks.length,0);
});
