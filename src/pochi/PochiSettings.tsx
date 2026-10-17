import { useState } from "react";
import type { Settings } from "./model.js";
import { isDesktop } from "./desktop.js";
import { playNotice } from "./sound.js";
export function PochiSettings({ settings, startedAt, save, cancel, reports, end, move, disabled }: {
  settings: Settings; startedAt?: number; save(s: Settings): void; cancel(): void; reports(): void; end(): void; move(): void; disabled: boolean;
}) {
  const [draft, setDraft] = useState(settings), [error, setError] = useState(""), [tab, setTab] = useState(0);
  const presets = (key: "remindMinutes" | "restMinutes", values: number[]) => <div className="ch">{values.map(n => <button key={n} type="button" className={draft[key] === n ? "on" : ""} aria-pressed={draft[key] === n} onClick={() => setDraft({ ...draft, [key]: n })}>{n}分</button>)}</div>;
  const number = (key: "remindMinutes" | "restMinutes" | "snoozeMinutes", label: string, min: number, max: number) => <label className="rw"><span>{label}</span><input required type="number" min={min} max={max} step="1" value={Number.isNaN(draft[key]) ? "" : draft[key]} onChange={e => setDraft({ ...draft, [key]: e.currentTarget.valueAsNumber })} />分</label>;
  type ToggleKey = "cameraDemo" | "awayCountsAsRest" | "postureDemo" | "saveHistory" | "reducedMotion" | "alwaysOnTop";
  const toggle = (key: ToggleKey, label: string, unavailable = false) => <div className={`rw${unavailable ? " dim" : ""}`}><span>{label}</span><button type="button" className={`tg${draft[key] ? " on" : ""}`} aria-label={label} aria-pressed={draft[key]} disabled={unavailable} onClick={() => setDraft({ ...draft, [key]: !draft[key], ...(key === "cameraDemo" && draft[key] ? { awayCountsAsRest: false, postureDemo: false } : {}) })}><i /></button></div>;
  const tabs = ["リズム", "通知音", "カメラ", "ろぐ"];
  return <form onSubmit={e => { e.preventDefault(); try { save(draft); } catch (cause) { setError(cause instanceof Error ? cause.message : "設定を確認してください。"); } }}>
    <h3>設定</h3><div className="ch tabs" role="tablist" aria-label="設定の種類">{tabs.map((label, i) => <button type="button" key={label} className={tab === i ? "on" : ""} role="tab" aria-selected={tab === i} aria-controls="pochi-setting-content" onClick={() => setTab(i)}>{label}</button>)}</div>
    <div role="tabpanel" id="pochi-setting-content" aria-label={tabs[tab]}>
      {tab === 0 && <><div className="rw"><span>今日のはじまり</span><b>{startedAt ? new Date(startedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "まだ始めていません"}</b></div><p className="sm2">どれくらいで声をかける？</p>{presets("remindMinutes", [25, 30, 45, 60])}<p className="sm2">休憩の長さ</p>{presets("restMinutes", [5, 10, 15])}<details><summary>詳細設定</summary>{number("remindMinutes", "お知らせまで", 1, 180)}{number("restMinutes", "休憩の長さ", 1, 60)}{number("snoozeMinutes", "「今は続ける」の後", 1, 120)}{toggle("reducedMotion", "動きを減らす")}{isDesktop && toggle("alwaysOnTop", "手前に表示する")}</details></>}
      {tab === 1 && <>{([['bark','ポチの「わん」','やさしい鳴き声'],['chime','やさしいチャイム','静かなオフィス向け'],['voice','ポチの声','「ひと休みしよう」'],['silent','音なし','ふきだしだけ']] as const).map(([sound, label, description]) => <div className={`op${draft.sound === sound ? " on" : ""}`} key={sound}><button type="button" className="sel" aria-pressed={draft.sound === sound} onClick={() => { setDraft({ ...draft, sound }); playNotice("ひと休みしよう", { sound }); }}><span className={`rd${draft.sound === sound ? " on" : ""}`} /><span>{label}<br /><span className="sm2" style={{ margin: 0, color: "inherit", opacity: .75 }}>{description}</span></span></button>{sound !== "silent" && <button type="button" className="try" onClick={() => playNotice("ひと休みしよう", { sound })}>ためす</button>}</div>)}</>}
      {tab === 2 && <>{toggle("cameraDemo", `カメラ · ${draft.cameraDemo ? "オン" : "オフ"}`)}{toggle("awayCountsAsRest", "席を外したら休憩にする", !draft.cameraDemo)}{toggle("postureDemo", "姿勢とまばたきを気にかける", !draft.cameraDemo)}<div className="priv">映像は保存も送信もしません。試作では実際にカメラは使いません。離席はメニューの「席を外す」で記録できます。</div></>}
      {tab === 3 && <>{toggle("saveHistory", "作業記録を残す")}<div className="rw"><span>保存先</span><span className="sm2">このPCだけ</span></div><p className="sm2">オフにすると今回の作業は保存しません。以前の記録は残ります。</p><div className="bs"><button type="button" onClick={reports}>記録を見る</button></div></>}
    </div>
    {error && <p role="alert">{error}</p>}<div className="bs"><button className="p" disabled={disabled}>完了</button></div><details><summary>変更を取り消す</summary><div className="bs"><button type="button" onClick={cancel}>保存せずにもどる</button></div></details>{isDesktop && <details><summary>アプリの操作</summary><div className="bs"><button type="button" className="drag" onPointerDown={move}>ウィンドウを移動</button><button type="button" onClick={end}>アプリを終了</button></div></details>}
  </form>;
}
