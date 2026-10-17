import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { PochiController } from "./controller.js";
import { LocalRepository } from "./repository.js";
import type { Settings, Session } from "./model.js";
import { formatDuration } from "./model.js";
import { desktop, isDesktop } from "./desktop.js";
import { PochiSprite } from "./PochiSprite.js";
import "./pochi.css";

function notify(text: string, settings: Settings) {
  if (settings.sound === "silent") return;
  const chime = () => { void new Audio("/pet/pochi/chime.wav").play().catch(() => {}); };
  const voice = "speechSynthesis" in window ? speechSynthesis.getVoices().find(v => v.lang.startsWith("ja")) : undefined;
  if (settings.sound === "voice" && voice) {
    speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice; utterance.lang = "ja-JP"; utterance.onerror = chime; speechSynthesis.speak(utterance);
  } else chime();
}
const date = (ms: number) => new Date(ms).toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function SessionReport({ session }: { session: Session }) {
  return <article className="pochi-report-entry">
    <header><div><small>{date(session.startedAt)}{session.endedAt === null ? " · 記録中" : " · 終了"}</small><h3>{session.task || "名前のない作業"}</h3></div><span className="pochi-pill">{session.kind === "study" ? "勉強" : "作業"}</span></header>
    <dl className="pochi-stats"><div><dt>作業時間</dt><dd>{formatDuration(session.workMs)}</dd></div><div><dt>休憩時間</dt><dd>{formatDuration(session.restMs)}</dd></div><div><dt>休憩回数</dt><dd>{session.breaks.length}<small> 回</small></dd></div></dl>
    {session.breaks.length === 0 ? <p className="pochi-muted">この作業では、まだ休憩していません。</p> : session.breaks.map((b, i) => <section className="pochi-break-entry" key={b.startedAt + ":" + i}>
      <h4>{i + 1}回目の休憩 <small>{date(b.startedAt)} · {formatDuration(b.durationMs)}</small></h4>
      <p><b>できたこと</b><br />{b.progress || "記入なし"}</p><p><b>困っていること</b><br />{b.problem || "記入なし"}</p>
    </section>)}
  </article>;
}
function SettingsForm({ settings, save, cancel, disabled }: { settings: Settings; save(s: Settings): void; cancel(): void; disabled: boolean }) {
  const [draft, setDraft] = useState(settings), [error, setError] = useState("");
  const number = (key: "remindMinutes" | "restMinutes" | "snoozeMinutes" | "petSize", label: string, min: number, max: number, suffix: string) => <label className="pochi-setting-row">{label}<span><input required type="number" min={min} max={max} step="1" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.currentTarget.valueAsNumber })} /> {suffix}</span></label>;
  return <form onSubmit={e => { e.preventDefault(); try { save(draft); } catch (cause) { setError(cause instanceof Error ? cause.message : "設定を確認してください。"); } }}>
    <h2>ポチの設定</h2><p className="pochi-muted">あなたのペースに合わせよう。</p>
    {number("remindMinutes", "休憩までの作業時間", 1, 180, "分")}{number("restMinutes", "休憩時間の目安", 1, 60, "分")}{number("snoozeMinutes", "「今は続ける」の後", 1, 120, "分")}{number("petSize", "ポチの大きさ", 150, 300, "px")}
    <label className="pochi-setting-row">お知らせの音<select value={draft.sound} onChange={e => setDraft({ ...draft, sound: e.target.value as Settings["sound"] })}><option value="chime">チャイム</option><option value="voice">日本語の声</option><option value="silent">音を鳴らさない</option></select></label>
    <label className="pochi-check"><input type="checkbox" checked={draft.reducedMotion} onChange={e => setDraft({ ...draft, reducedMotion: e.target.checked })} />動きを減らす</label>
    {isDesktop && <label className="pochi-check"><input type="checkbox" checked={draft.alwaysOnTop} onChange={e => setDraft({ ...draft, alwaysOnTop: e.target.checked })} />ほかのウィンドウより手前に表示</label>}
    {error && <p role="alert">{error}</p>}<div className="pochi-actions"><button type="button" onClick={cancel}>もどる</button><button className="pochi-primary" disabled={disabled}>保存してもどる</button></div>
  </form>;
}
export default function PochiApp() {
  const [controller] = useState(() => new PochiController(new LocalRepository({
    getItem: k => window.localStorage.getItem(k), setItem: (k, v) => window.localStorage.setItem(k, v), removeItem: k => window.localStorage.removeItem(k),
  }, crypto.randomUUID()), { monotonic: () => performance.now(), wall: Date.now }, new URLSearchParams(location.search).get("demo") === "1", undefined, notify));
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [task, setTask] = useState(""), [kind, setKind] = useState<"work" | "study">("work"), [nativeError, setNativeError] = useState("");
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data, panel } = view, active = data.active, phase = active?.phase;
  const openBreak = active?.breaks.find(b => b.endedAt === null);
  const failed = !!view.error;
  useEffect(() => {
    controller.mount(); const interval = setInterval(controller.tick, 200);
    document.documentElement.dataset.pochiDesktop = String(isDesktop);
    const visibility = () => controller.setPaused(document.hidden);
    const beforeUnload = (event: BeforeUnloadEvent) => { if (controller.getSnapshot().error) { event.preventDefault(); event.returnValue = ""; } };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") controller.closePanel(); };
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const motionPreference = () => setSystemReduced(media.matches); media.addEventListener("change", motionPreference);
    let disposed = false, unlisten = () => {};
    void desktop.onClose(() => { controller.end(true); }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(() => setNativeError("終了操作を接続できません。画面の終了ボタンから記録を保存してください。"));
    window.addEventListener("pagehide", controller.pageHide); window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", visibility); window.addEventListener("keydown", key);
    return () => { disposed = true; clearInterval(interval); if (clickTimer.current) clearTimeout(clickTimer.current);
      unlisten(); controller.unmount(); window.removeEventListener("pagehide", controller.pageHide); window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("keydown", key); media.removeEventListener("change", motionPreference); };
  }, [controller]);
  useEffect(() => { void desktop.pin(data.settings.alwaysOnTop).catch(() => setNativeError("手前に固定できませんでした。")); }, [data.settings.alwaysOnTop]);
  const begin = () => { if (!failed) controller.start(task, kind); };
  const clickPet = (detail: number) => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    if (detail > 1) return;
    const tap = () => { if (controller.getSnapshot().panel === "start") begin(); else controller.tap(); };
    if (detail === 0) tap(); else clickTimer.current = setTimeout(tap, 550);
  };
  const reports = [...(active ? [active] : []), ...data.history];
  return <main className="pochi-app" style={{ "--pet-size": `${data.settings.petSize}px` } as CSSProperties}>
    {!isDesktop && <header className="pochi-page-header"><a href="#" aria-label="ポチ ホーム" onClick={e => { e.preventDefault(); controller.closePanel(); }}><span className="pochi-logo">ぽ</span> ポチ <small>休憩のおとも</small></a><span className="pochi-pill">{controller.demo ? "デモ · 12秒でお知らせ" : "この端末に保存"}</span></header>}
    <section className="pochi-room" aria-label="ポチとの作業スペース">
      {!isDesktop && <div className="pochi-intro"><span className="pochi-eyebrow">ひと息、つこう。</span><h1>小さな休憩を、<br />いっしょに。</h1><p>がんばる時間も、休む時間も。<br />ポチがそっと寄り添います。</p><div className="pochi-guide"><span>01 作業を記録</span><span>02 ひと息つく</span><span>03 できたことを残す</span></div></div>}
      <div className="pochi-dock">
        <div className={`pochi-bubble ${panel === "report" ? "pochi-bubble--report" : ""}`} aria-label="ポチのメニュー">
          {view.error && <div role="alert" className="pochi-alert">{view.error}<div className="pochi-actions"><button onClick={() => controller.checkpoint()}>保存を再試行</button><button onClick={() => location.reload()}>再読み込み</button></div></div>}
          {nativeError && <p role="alert" className="pochi-alert">{nativeError}</p>}
          {view.notice && <p role="status" className="pochi-muted">{view.notice}</p>}
          {phase === "reminder" && !["reminder", "settings"].includes(panel) && <button className="pochi-alert" onClick={controller.tap}>休憩のお知らせが届いているよ</button>}
          {panel === "home" && <><span className="pochi-eyebrow">こんにちは</span><h2>今日も、いっしょに。</h2><p>今日は何をしようか？</p><button className="pochi-primary pochi-full" onClick={controller.tap} disabled={failed}>作業を記録</button></>}
          {panel === "start" && <form onSubmit={e => { e.preventDefault(); begin(); }}><h2>今日は何から始める？</h2><div className="pochi-tabs"><button type="button" aria-pressed={kind === "work"} onClick={() => setKind("work")}>作業</button><button type="button" aria-pressed={kind === "study"} onClick={() => setKind("study")}>勉強</button></div><label>今回の作業<input maxLength={120} autoFocus value={task} placeholder="例：企画書のつづき" onChange={e => setTask(e.target.value)} /></label><p className="pochi-muted">もう一度ポチをクリックしても始められるよ。</p><button className="pochi-primary pochi-full" disabled={failed}>作業の記録をはじめる</button></form>}
          {panel === "settings" && <SettingsForm settings={data.settings} save={s => controller.saveSettings(s)} cancel={controller.closePanel} disabled={failed} />}
          {panel === "menu" && <><h2>ここにいるよ。</h2><p>{active?.task || "あなたのペースで、少しずつ。"}</p><div className="pochi-actions"><button className="pochi-primary" onClick={controller.accept} disabled={failed}>いま休憩する</button><button onClick={controller.continueWork}>作業を続ける</button></div><button className="pochi-text-button" onClick={() => controller.end()}>今回の作業を終える</button></>}
          {panel === "quiet" && <><span className="pochi-eyebrow">作業中</span><h2>ここで、待ってるね。</h2><p>{view.message || "時間になったら声をかけるよ。"}</p><div className="pochi-actions"><button onClick={controller.accept} disabled={failed}>いま休憩する</button><button onClick={controller.openReports}>記録を見る</button></div></>}
          {panel === "reminder" && <><span className="pochi-eyebrow">ひと息の時間</span><h2>少し立って、<br />休憩しない？</h2><p>のびをして、目も休めよう。</p><div className="pochi-actions"><button className="pochi-primary" onClick={controller.accept} disabled={failed}>はい・休憩する</button><button onClick={controller.decline} disabled={failed}>いいえ・今は続ける</button></div></>}
          {panel === "rest" && <><span className="pochi-eyebrow">{view.restingDone ? "そろそろ戻る？" : "のんびり、休憩中"}</span><h2>ここまで、おつかれさま。</h2><p className="pochi-muted">ひとこと残して、ゆっくり休もう。メモは自動で保存するよ。</p><label>どこまでできた？<textarea maxLength={2000} rows={2} value={openBreak?.progress ?? ""} disabled={failed} onChange={e => controller.note(e.target.value, openBreak?.problem ?? "")} /></label><label>困っていることは？<textarea maxLength={2000} rows={2} value={openBreak?.problem ?? ""} disabled={failed} onChange={e => controller.note(openBreak?.progress ?? "", e.target.value)} /></label><div className="pochi-actions"><button className="pochi-primary" onClick={controller.returnToWork} disabled={failed}>戻ったよ</button><button onClick={controller.openReports}>記録を見る</button></div></>}
          {panel === "welcome" && <><span className="pochi-eyebrow">おかえりなさい</span><h2>また、いっしょに。</h2><p>少しリフレッシュできたかな？</p><button className="pochi-primary pochi-full" onClick={controller.continueWork}>作業を続ける</button></>}
          {panel === "recovery" && <><h2>前回の記録が残っているよ。</h2><p>閉じていた間の時間は含めていません。続きを始める？</p><div className="pochi-actions"><button className="pochi-primary" onClick={controller.resume} disabled={failed}>前回の作業を続ける</button><button onClick={() => controller.end()} disabled={failed}>終了して記録を見る</button></div></>}
          {panel === "report" && <><span className="pochi-eyebrow">作業のふりかえり</span><h2>作業と休憩の記録</h2>{reports.length === 0 ? <p>まだ記録はありません。ポチと作業を始めてみよう。</p> : reports.map(s => <SessionReport key={s.id} session={s} />)}<div className="pochi-actions"><button onClick={controller.closePanel}>もどる</button>{active && <button onClick={() => controller.end()} disabled={failed}>作業を終えて保存</button>}{view.closing && isDesktop && <button className="pochi-primary" disabled={failed} onClick={() => { if (controller.checkpoint()) void desktop.close().catch(() => setNativeError("ウィンドウを閉じられませんでした。")); }}>保存してアプリを閉じる</button>}</div></>}
        </div>
        <div className="pochi-pet-row"><button className="pochi-pet-button" style={{ width: data.settings.petSize, height: data.settings.petSize }} aria-label="ポチ：クリックで作業を記録、ダブルクリックで設定" onClick={e => clickPet(e.detail)} onDoubleClick={() => { if (clickTimer.current) clearTimeout(clickTimer.current); controller.openSettings(); }}><PochiSprite motion={view.motion} reducedMotion={data.settings.reducedMotion || systemReduced} onComplete={controller.completeAnimation} /></button></div>
        <div className="pochi-status"><span className={`pochi-status-dot ${phase === "resting" ? "is-resting" : ""}`} /><span>{phase === "resting" ? "休憩中" : phase === "recovered" ? "再開を待っています" : active ? "作業中" : "待機中"}</span><time aria-label="経過時間">{formatDuration(phase === "resting" ? openBreak?.durationMs ?? 0 : active?.workMs ?? 0)}</time></div>
        <nav className="pochi-toolbar" aria-label="ポチの操作"><button onClick={controller.openSettings}>設定</button><button onClick={controller.openReports}>記録</button><button onClick={controller.turn} disabled={!!active && phase !== "working"}>ひとまわり</button>{isDesktop && <button aria-label="ウィンドウを移動" onPointerDown={() => { void desktop.drag().catch(() => setNativeError("ウィンドウを移動できませんでした。")); }}>移動</button>}<button onClick={() => controller.end(true)}>終了</button></nav>
        <p className="pochi-hint">クリックで作業 · ダブルクリックで設定{view.paused && " · この画面を離れている間は計時を一時停止"}</p>
      </div>
    </section>
  </main>;
}
