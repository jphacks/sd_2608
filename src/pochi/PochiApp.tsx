import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PochiController } from "./controller.js";
import { LocalRepository } from "./repository.js";
import type { Session } from "./model.js";
import { desktop, isDesktop } from "./desktop.js";
import { PochiSprite } from "./PochiSprite.js";
import { playNotice } from "./sound.js";
import { PochiSettings } from "./PochiSettings.js";
import { SpeechInput } from "./SpeechInput.js";
import "./pochi.css";

const hm = (ms: number) => new Date(ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
const minutes = (ms: number) => `${Math.floor(ms / 60_000)}分`;
function SessionReport({ session }: { session: Session }) {
  return <article className="report-entry">
    {session.task && <p className="m">{session.task}</p>}
    <div className="rr"><span>開始</span><b>{hm(session.startedAt)}</b></div>
    <div className="rr"><span>作業時間</span><b>{minutes(session.workMs)}</b></div>
    <div className="rr"><span>休憩</span><b>{session.breaks.length}回</b></div>
    {session.breaks.length ? session.breaks.map((b, i) => <div className="rr" key={`${b.startedAt}:${i}`}><span>{hm(b.startedAt)}</span><span style={{ textAlign: "right", whiteSpace: "pre-wrap" }}>進み：{b.progress || "—"}<br />困りごと：{b.problem || "—"}</span></div>) : <div className="rr"><span className="sm">メモはまだありません</span></div>}
  </article>;
}
export default function PochiApp() {
  const [controller] = useState(() => {
    const prefix = new URLSearchParams(location.search).get("demo") === "1" ? "demo:" : "";
    return new PochiController(new LocalRepository({
      getItem: k => window.localStorage.getItem(prefix + k),
      setItem: (k, v) => window.localStorage.setItem(prefix + k, v),
      removeItem: k => window.localStorage.removeItem(prefix + k),
    }, crypto.randomUUID()), { monotonic: () => performance.now(), wall: Date.now }, !!prefix, undefined, playNotice);
  });
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [task, setTask] = useState(""), [kind, setKind] = useState<"work" | "study">("work");
  const [nativeError, setNativeError] = useState(""), [quietMessage, setQuietMessage] = useState(false);
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data, panel } = view, active = data.active, phase = active?.phase;
  const failed = !!view.error, reduced = data.settings.reducedMotion || systemReduced;
  const openBreak = active?.breaks.find(b => b.endedAt === null);
  const readyCards = data.cards.filter(c => c.status === "ready");
  const pendingCards = data.cards.filter(c => c.status !== "ready");
  const reports = [...(active ? [active] : []), ...data.history];
  const problems = (active?.breaks ?? data.history[0]?.breaks ?? []).filter(b => b.problem.trim());
  const waking = view.motion.id === "rest_to_sit" && ["settings", "menu", "report", "welcome", "reminder"].includes(panel);
  const hideBubble = waking || (panel === "quiet" && !quietMessage) || panel === "away";
  const latest = reports[0];
  useEffect(() => {
    controller.mount(); const interval = setInterval(controller.tick, 200);
    document.documentElement.dataset.pochiDesktop = String(isDesktop);
    const visibility = () => controller.setPaused(document.hidden);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (controller.getSnapshot().error) { event.preventDefault(); event.returnValue = ""; } };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") controller.closePanel(); };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const motionPreference = () => setSystemReduced(media.matches); media.addEventListener("change", motionPreference);
    let disposed = false, unlisten = () => {};
    void desktop.onClose(() => { controller.end(true); }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => setNativeError("終了操作を接続できません。メニューから記録を保存してください。"));
    window.addEventListener("pagehide", controller.pageHide); window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("keydown", key);
    return () => { disposed = true; clearInterval(interval); if (clickTimer.current) clearTimeout(clickTimer.current);
      unlisten(); controller.unmount(); window.removeEventListener("pagehide", controller.pageHide); window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("keydown", key); media.removeEventListener("change", motionPreference); };
  }, [controller]);
  useEffect(() => {
    if (panel !== "quiet" || !view.message) { setQuietMessage(false); return; }
    setQuietMessage(true); const timer = setTimeout(() => setQuietMessage(false), 2400);
    return () => clearTimeout(timer);
  }, [panel, view.message, active?.id]);
  useEffect(() => { void desktop.pin(data.settings.alwaysOnTop).catch(() => setNativeError("手前に固定できませんでした。")); }, [data.settings.alwaysOnTop]);
  const begin = () => { if (!failed) controller.start(task, kind); };
  const clickPet = (detail: number) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (detail > 1) return;
    const tap = () => { if (controller.getSnapshot().panel === "start") begin(); else controller.tap(); };
    if (detail === 0) tap(); else clickTimer.current = setTimeout(tap, 550);
  };
  return <main className="pochi-app" data-reduced-motion={reduced} aria-label="ポチ">
    <div className="pet">
      <div key={panel} className={`bub${panel === "settings" ? " wide" : ""}`} role="dialog" aria-label={panel === "settings" ? "設定" : "ポチのふきだし"} aria-live="polite" hidden={hideBubble && !view.error && !nativeError && !view.notice}>
        {view.error && <div role="alert" className="alert">{view.error}<div className="bs"><button onClick={() => controller.checkpoint()}>保存を再試行</button><button onClick={() => location.reload()}>再読み込み</button></div></div>}
        {nativeError && <p role="alert" className="alert">{nativeError}</p>}
        {view.notice && <p role="status" className="sm">{view.notice}</p>}
        {phase === "reminder" && !["reminder", "settings"].includes(panel) && <button onClick={controller.tap}>休憩のお知らせが届いているよ</button>}
        {panel === "home" && <p className="m">タップして、今日の作業を始めよう</p>}
        {panel === "start" && <form onSubmit={e => { e.preventDefault(); begin(); }}><h3>今日は何から始める？</h3><div className="ch"><button type="button" className={kind === "work" ? "on" : ""} aria-pressed={kind === "work"} onClick={() => setKind("work")}>作業</button><button type="button" className={kind === "study" ? "on" : ""} aria-pressed={kind === "study"} onClick={() => setKind("study")}>勉強</button></div><SpeechInput value={task} onChange={setTask} /><div className="bs"><button className="p" disabled={failed}>はじめる</button></div></form>}
        {panel === "settings" && <PochiSettings settings={data.settings} startedAt={active?.startedAt} save={s => controller.saveSettings(s)} cancel={controller.closePanel} reports={controller.openReports} end={() => controller.end(true)} move={() => { void desktop.drag().catch(() => setNativeError("ウィンドウを移動できませんでした。")); }} disabled={failed} />}
        {panel === "menu" && <><p className="m">どうする？</p><div className="bs"><button onClick={controller.openReports} className="p">作業記録を見る</button><button onClick={controller.openSettings}>設定</button><button onClick={() => controller.end()}>作業を終える</button><button onClick={controller.closePanel}>なんでもない</button></div><details className="pet-actions"><summary>その他の操作</summary><div className="bs"><button onClick={controller.accept} disabled={failed}>いま休憩する</button><button onClick={controller.leave}>席を外す</button><button onClick={controller.turn}>ひとまわり</button>{isDesktop && <button className="drag" onPointerDown={() => { void desktop.drag().catch(() => setNativeError("ウィンドウを移動できませんでした。")); }}>ウィンドウを移動</button>}</div></details></>}
        {panel === "quiet" && quietMessage && <p className="m">{view.message}</p>}
        {panel === "reminder" && <><p className="m">しばらく座っていますね。少し立って休憩しませんか？</p><p className="sm">{active && `${hm(active.startedAt)} 開始・${minutes(active.workMs)}経過`}</p><div className="bs"><button className="p" onClick={controller.accept} disabled={failed}>休憩する</button><button onClick={controller.decline} disabled={failed}>今は続ける</button></div></>}
        {(panel === "rest" || panel === "generating") && <><p className="m">ここまでの作業記録をまとめています。</p><div className="dots" aria-hidden="true"><span /><span /><span /></div>{(panel === "rest" || view.noteOpen) ? <><p className="sm" style={{ marginTop: 10 }}>ひとこと残す？（空でもOK）</p><label htmlFor="note-progress">どこまで進んだ</label><input id="note-progress" maxLength={2000} value={openBreak?.progress ?? ""} disabled={failed} onChange={e => controller.note(e.target.value, openBreak?.problem ?? "")} /><label htmlFor="note-problem">困っていること</label><input id="note-problem" maxLength={2000} value={openBreak?.problem ?? ""} disabled={failed} onChange={e => controller.note(openBreak?.progress ?? "", e.target.value)} /><div className="bs"><button className="p" onClick={controller.finishNote} disabled={failed}>残す</button><button onClick={controller.skipNote} disabled={failed}>書かない</button></div></> : <p className="sm" style={{ marginTop: 10 }}>残したよ。戻ったら続きを見ようね</p>}<div className="bs"><button onClick={controller.returnToWork} disabled={failed}>戻ったよ</button></div></>}
        {panel === "ready" && <><div className="ok">作業レポートができました。</div><div className="bs"><button className="p" onClick={controller.openReports}>レポートを見る</button>{(phase === "resting" || phase === "away") && <button onClick={controller.returnToWork}>戻ったよ</button>}</div></>}
        {panel === "tasks" && <><h3>このあとやること</h3>{problems.length ? problems.map((b, i) => <div className="rr" key={i}><span>{b.problem}</span></div>) : <p className="sm">まだ記録がありません。戻ってから書いても大丈夫</p>}<div className="bs"><button className="p" onClick={controller.continueWork}>作業にもどる</button></div></>}
        {panel === "welcome" && <><p className="m">おかえりなさい。続きの作業を確認しましょう。</p>{pendingCards.length > 0 && <p className="sm">レポート作成中…</p>}<div className="bs"><button className="p" onClick={controller.openTasks}>続きを見る</button>{readyCards.length > 0 && <button onClick={controller.openReports}>レポートを見る</button>}<button onClick={controller.continueWork}>作業にもどる</button></div></>}
        {panel === "recovery" && <><h3>前回の記録が残っているよ。</h3><p className="sm">閉じていた間の時間は含めていません。続きを始める？</p><div className="bs"><button className="p" onClick={controller.resume} disabled={failed}>前回の作業を続ける</button><button onClick={() => controller.end()} disabled={failed}>終了して記録を見る</button></div></>}
        {panel === "report" && <><h3>{!active && latest ? "今日もおつかれさま！" : "作業記録"}</h3>{!active && latest && <p className="m">{hm(latest.startedAt)}〜{hm(latest.endedAt ?? latest.startedAt)}・合計{minutes(latest.workMs)}・休憩{latest.breaks.length}回</p>}{readyCards.length > 0 && <><div className="ok">作業レポートができました</div><details><summary>途中のレポート</summary>{readyCards.map(card => <SessionReport key={card.id} session={card.session} />)}</details></>}{reports.length ? reports.map((s, i) => i ? <details key={s.id}><summary>{new Date(s.startedAt).toLocaleDateString("ja-JP")} {hm(s.startedAt)} · {s.task || "作業"}</summary><SessionReport session={s} /></details> : <SessionReport key={s.id} session={s} />) : <p className="sm">まだ記録はありません</p>}<div className="bs"><button className="p" onClick={controller.closePanel}>{active ? "もどる" : "またね"}</button>{active && <button onClick={() => controller.end()} disabled={failed}>作業を終える</button>}{view.closing && isDesktop && <button disabled={failed} onClick={() => { if (controller.checkpoint()) void desktop.close().catch(() => setNativeError("ウィンドウを閉じられませんでした。")); }}>保存してアプリを閉じる</button>}</div></>}
      </div>
      <button className={`chip${hideBubble ? " on" : ""}`} onClick={() => phase === "away" ? controller.returnToWork() : controller.tap()} aria-label={phase === "away" ? "離席中。クリックして戻る" : "作業メニューを開く"}>{phase === "away" ? "離席中 · 戻ったよ" : active ? `${active.kind === "study" ? "勉強" : "作業"} ${hm(active.startedAt)}〜・${minutes(active.workMs)}` : ""}</button>
      <button className="gear" aria-label="設定" onClick={controller.openSettings}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z" /></svg></button>
      <div className={`dwrap${view.motion.id === "rest" ? " lying" : ""}`}><span className="zz" aria-hidden="true">z z</span><button id="petbtn" aria-label="ポチ：クリックで作業、ダブルクリックで設定" onClick={e => clickPet(e.detail)} onDoubleClick={() => { if (clickTimer.current) clearTimeout(clickTimer.current); controller.openSettings(); }}><PochiSprite motion={view.motion} reducedMotion={reduced} onComplete={controller.completeAnimation} /></button></div>
    </div>
  </main>;
}
