import { useState } from "react";
import type { Settings } from "./model.js";
import { isDesktop } from "./desktop.js";
import { playNotice } from "./sound.js";
export function PochiSettings({ settings, startedAt, save, cancel, reports, disabled }: {
  settings: Settings; startedAt?: number; save(s: Settings): void; cancel(): void; reports(): void; disabled: boolean;
}) {
  const [draft, setDraft] = useState(settings), [error, setError] = useState(""), [tab, setTab] = useState(0);
  const numbers = (key: "remindMinutes" | "restMinutes", values: number[]) => <div className="pochi-presets">{values.map(n => <button key={n} type="button" aria-pressed={draft[key] === n} onClick={() => setDraft({ ...draft, [key]: n })}>{n}分</button>)}</div>;
  const number = (key: "remindMinutes" | "restMinutes" | "snoozeMinutes" | "petSize", label: string, min: number, max: number, suffix: string) => <label className="pochi-setting-row">{label}<span><input required type="number" min={min} max={max} step="1" value={Number.isNaN(draft[key]) ? "" : draft[key]} onChange={e => setDraft({ ...draft, [key]: e.currentTarget.valueAsNumber })} /> {suffix}</span></label>;
  const toggle = (key: "cameraDemo" | "awayCountsAsRest" | "postureDemo" | "saveHistory", label: string, unavailable = false) => <label className="pochi-check"><input type="checkbox" checked={draft[key]} disabled={unavailable} onChange={e => setDraft({ ...draft, [key]: e.target.checked,
    ...(key === "cameraDemo" && !e.target.checked ? { awayCountsAsRest: false, postureDemo: false } : {}) })} />{label}</label>;
  return <form onSubmit={e => { e.preventDefault(); try { save(draft); } catch (cause) { setError(cause instanceof Error ? cause.message : "設定を確認してください。"); } }}>
    <h2>ポチの設定</h2><div className="pochi-settings-tabs" role="tablist" aria-label="設定の種類">{["リズム", "通知音", "カメラ", "記録"].map((label, i) => <button type="button" key={label} role="tab" aria-selected={tab === i} aria-controls="pochi-setting-content" onClick={() => setTab(i)}>{label}</button>)}</div>
    <div role="tabpanel" id="pochi-setting-content" aria-label={["リズム", "通知音", "カメラ", "記録"][tab]}>
      {tab === 0 && <><p className="pochi-muted">今日のはじまり：{startedAt ? new Date(startedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "まだ始めていません"}</p>
        {number("remindMinutes", "どれくらいで声をかける？", 1, 180, "分")}{numbers("remindMinutes", [25, 30, 45, 60])}
        {number("restMinutes", "休憩の長さ", 1, 60, "分")}{numbers("restMinutes", [5, 10, 15])}
        {number("snoozeMinutes", "「今は続ける」の後", 1, 120, "分")}{number("petSize", "ポチの大きさ", 150, 300, "px")}
        <label className="pochi-check"><input type="checkbox" checked={draft.reducedMotion} onChange={e => setDraft({ ...draft, reducedMotion: e.target.checked })} />動きを減らす</label>
        {isDesktop && <label className="pochi-check"><input type="checkbox" checked={draft.alwaysOnTop} onChange={e => setDraft({ ...draft, alwaysOnTop: e.target.checked })} />ほかのウィンドウより手前に表示</label>}</>}
      {tab === 1 && <>{([['bark','ポチの「わん」','やさしい鳴き声'],['chime','やさしいチャイム','静かなオフィス向け'],['voice','ポチの声','「ひと休みしよう」'],['silent','音なし','ふきだしだけ']] as const).map(([sound, label, description]) => <div className="pochi-sound-option" key={sound}><label><input type="radio" name="notice-sound" checked={draft.sound === sound} onChange={() => setDraft({ ...draft, sound })} /><span>{label}<small>{description}</small></span></label>{sound !== "silent" && <button type="button" onClick={() => playNotice("ひと休みしよう", { sound })}>ためす</button>}</div>)}<p className="pochi-muted">日本語の音声がない場合はチャイムでお知らせします。</p></>}
      {tab === 2 && <>{toggle("cameraDemo", "カメラの設定を試す（デモ）")}{toggle("awayCountsAsRest", "席を外した時間を休憩時間に含める", !draft.cameraDemo)}{toggle("postureDemo", "姿勢とまばたきのお知らせ（デモ設定）", !draft.cameraDemo)}<p className="pochi-privacy">この画面では設定の演示だけを行います。カメラは開かず、映像の取得・保存・送信も行いません。離席は「席を外す」ボタンで記録できます。自動検出と姿勢判定は未接続です。</p></>}
      {tab === 3 && <>{toggle("saveHistory", "作業記録をこの端末に残す")}<p className="pochi-muted">オフにすると、今回の作業は終了後に保存しません。以前に保存した記録は残ります。</p><div className="pochi-setting-row">保存先<span>この端末だけ</span></div><button type="button" onClick={reports}>記録を見る</button></>}
    </div>
    {error && <p role="alert">{error}</p>}<div className="pochi-actions"><button type="button" onClick={cancel}>もどる</button><button className="pochi-primary" disabled={disabled}>保存してもどる</button></div>
  </form>;
}
