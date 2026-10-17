import { useState } from "react";
import type { PochiController, PochiView } from "./controller.js";
const phases = { working: "作業中", reminder: "休憩のお知らせ", resting: "休憩中", away: "離席中", recovered: "再開待ち" };
const actionLabels = { idle: "待機", record: "A04 記録", reminder: "A05 休憩通知", rest: "A03 伏せ", welcome: "A02 おかえり", sit_to_rest: "A06 お座り→伏せ", rest_to_sit: "A07 伏せ→お座り", turn_sit: "一周→お座り" };
export function DemoControls({ controller, view }: { controller: PochiController; view: PochiView }) {
  const [tags, setTags] = useState(false), phase = view.data.active?.phase;
  return <aside className="pochi-demo" aria-label="演示コントロール"><h2>演示コントロール</h2><p>開始 → お知らせ → 休憩 → おかえり → 終了。時間と離席を手動で進められます。</p><p className="pochi-privacy">デモの記録は通常の記録と別に保存します。カメラや外部AIは使いません。</p><fieldset><legend>時間の速さ</legend><div className="pochi-presets">{([1,60,600] as const).map(speed => <button key={speed} aria-pressed={view.speed === speed} onClick={() => controller.setSpeed(speed)}>×{speed}</button>)}</div></fieldset><label className="pochi-check"><input type="checkbox" checked={tags} onChange={e => setTags(e.target.checked)} />動作番号を表示</label><p className="pochi-demo-phase">{phase ? phases[phase] : "待機中"}{tags && <small>{actionLabels[view.motion.id]}</small>}</p>
    {!phase && <button onClick={controller.tap}>ポチをクリックして開始</button>}
    {phase === "working" && <><button onClick={() => controller.demoAdvance(Math.max(0, view.data.active!.nextReminderWorkMs - view.data.active!.workMs))}>今すぐお知らせの時間へ</button><button onClick={controller.leave}>席を外す（自然離席の演示）</button></>}
    {phase === "away" && <button onClick={() => controller.demoAdvance(300_000)}>離席5分を経過させる</button>}
    {(phase === "away" || phase === "resting") && <button onClick={controller.returnToWork}>席に戻る・おかえり</button>}
    {phase && <button onClick={() => controller.end()}>作業を終える</button>}
    <button onClick={controller.openSettings}>設定を開く</button><button onClick={controller.openReports}>記録を見る</button>
  </aside>;
}
