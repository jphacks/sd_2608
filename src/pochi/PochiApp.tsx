import { useEffect, useRef, useState } from "react";
import type { AppViewProps } from "../contracts/ui.js";
import type { TimingProfile } from "../contracts/domain.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { ReportPanel } from "../components/ReportPanel.js";
import { ReportHistory } from "../components/ReportHistory.js";
import { PochiSprite } from "./PochiSprite.js";
import "./pochi.css";

const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
type Panel = "home" | "start" | "settings" | "history" | "menu" | "quiet";

/** main の state/actions を表示する。計時・通知・保存の状態は持たない。 */
export default function PochiApp({ state, actions, desktop = false, profile = "normal", manual = false }: AppViewProps & {
  desktop?: boolean; profile?: TimingProfile; manual?: boolean;
}) {
  const [panel, setPanel] = useState<Panel>("home");
  const [consent, setConsent] = useState(false);
  const [externalConsent, setExternalConsent] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [quietMessage, setQuietMessage] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const snapshot = state.snapshot;
  const running = snapshot?.runtime.phase === "running";
  const busy = state.pending !== null || state.connection !== "connected";
  const settings = snapshot?.settings;
  const usesAi = settings?.reportMode === "ai" && !!settings.provider && settings.hasApiKey;
  const reportOpen = state.report.phase !== "closed";
  const generating = snapshot?.jobs.some(job => job.status === "running" || job.status === "queued");
  const scheduled = snapshot?.jobs.some(job => job.status === "scheduled");
  const reduced = !!settings?.reducedMotion || systemReduced;
  const showAdvanceNotice = !!state.advanceNotice && (panel === "home" || panel === "quiet")
    && state.connection === "connected" && !state.error
    && !state.bubble && !reportOpen && !generating && !scheduled;
  const attention = state.connection !== "connected" || !!state.error || !!snapshot?.warning || !!state.bubble || reportOpen || generating || scheduled || showAdvanceNotice;
  const hideBubble = dismissed || (panel === "quiet" && !quietMessage && !attention);
  // 毎秒の計時更新では再表示せず、新しい通知・エラー・完成カードは表示する。
  const messageKeys = [
    `connection:${state.connection}`,
    state.bubble && `reminder:${state.bubble.reminderId}`,
    state.error && `error:${state.error.code}:${state.error.message}`,
    snapshot?.warning && `warning:${snapshot.warning.code}:${snapshot.warning.message}`,
    state.pet.greeting && `greeting:${state.pet.playbackToken}`,
    state.advanceNotice && `advance:${state.advanceNotice.sessionId}`,
    state.report.phase !== "closed" && `report:${state.report.phase}:${state.report.phase === "ready" ? `${state.report.report.id}:${state.report.report.updatedAt}` : state.report.reportId}`,
    ...(snapshot?.jobs.map(job => `job:${job.id}:${job.status}:${job.attempt}`) ?? []),
  ].filter((key): key is string => !!key);
  const messageKey = JSON.stringify(messageKeys);
  const previousMessages = useRef(messageKeys);
  useEffect(() => {
    const next: string[] = JSON.parse(messageKey);
    if (next.some(key => !previousMessages.current.includes(key))) setDismissed(false);
    previousMessages.current = next;
  }, [messageKey]);
  useEffect(() => {
    setConsent(false); setExternalConsent(false);
    setDismissed(false);
    if (running) setPanel("quiet");
    else if (running === false) setPanel(current => current === "quiet" ? "home" : current);
  }, [snapshot?.runtimeId, settings?.revision, running]);
  useEffect(() => {
    if (panel !== "quiet" || !running) { setQuietMessage(false); return; }
    setQuietMessage(true);
    const timer = setTimeout(() => setQuietMessage(false), 2400);
    return () => clearTimeout(timer);
  }, [panel, running]);
  useEffect(() => {
    document.documentElement.dataset.pochiDesktop = String(desktop);
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(media.matches);
    media.addEventListener("change", change);
    return () => { media.removeEventListener("change", change); delete document.documentElement.dataset.pochiDesktop;
      if (clickTimer.current) clearTimeout(clickTimer.current); };
  }, [desktop]);
  const openPanel = (next: Panel) => { setDismissed(false); setPanel(next); };
  const closePanel = () => openPanel(running ? "quiet" : "home");
  const closeMessage = () => {
    if (state.bubble && !busy && !state.bubble.disabled) void actions.answer("no");
    if (state.error) actions.dismissError();
    if (reportOpen) actions.closeReport();
    if (showAdvanceNotice) actions.dismissAdvanceNotice();
    setPanel(running ? "quiet" : "home");
    setDismissed(true);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panel !== "home" && panel !== "quiet") closePanel();
      else closeMessage();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [actions, state.bubble, state.error, reportOpen, busy, panel, running, showAdvanceNotice]);
  const begin = (ai: boolean) => {
    if (!snapshot || !consent || (ai && !externalConsent)) return;
    void actions.start({ profile, expectedSettingsRevision: snapshot.settings.revision, reportMode: ai ? "ai" : "local",
      consent: { activity: true, history: true, externalReport: ai && externalConsent } });
  };
  const retry = (id?: string) => {
    if (snapshot?.runtime.effectiveReportMode === "ai" && settings?.provider && !window.confirm(
      `このレポートの固定済み履歴を次の AI へ再送信しますか？\n${settings.provider.endpoint}\nモデル: ${settings.provider.model}`,
    )) return;
    void (async () => {
      if (id) await actions.openReport(id);
      await actions.retryReport();
    })();
  };
  const reports = () => { openPanel("history"); void actions.openLatestReport(); };
  const tap = () => openPanel(running ? "menu" : "start");
  const togglePin = () => {
    const value = !pinned; setPinned(value); void actions.pinWindow(value);
  };
  return <main className="pochi-app" data-reduced-motion={reduced} aria-label="ポチ">
    <div className="pet">
      <div className={`bub${panel === "settings" ? " wide" : ""}`} data-pochi-hit role="dialog" aria-label={panel === "settings" ? "ポチの設定" : "ポチのふきだし"} aria-live="polite" hidden={hideBubble}>
        <div className="bub-header">
          {panel === "menu" && <button className="gear" aria-label="設定" onClick={() => openPanel("settings")}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z" /></svg></button>}
          <button className="bubble-close" aria-label={showAdvanceNotice ? "休憩の予告を閉じる" : "メッセージを閉じる"} onClick={closeMessage}>×</button>
        </div>
        <div className="bub-body">
        {state.connection !== "connected" && <p className="sm" role="status">{state.connection === "connecting" ? "アプリへ接続しています…" : "アプリへ接続できません。"}</p>}
        {state.connection === "error" && !state.error && <div className="bs"><button onClick={() => { void actions.reconnect(); }}>再接続</button></div>}
        {profile === "demo" && <p className="sm">短縮デモ · {manual ? "手動顔入力（実カメラ不使用）" : "実カメラ"}</p>}
        {state.error && <div role="alert" className="alert">{state.error.message}<div className="bs"><button onClick={actions.dismissError}>エラーを閉じる</button>{state.connection === "error" && <button onClick={() => { void actions.reconnect(); }}>再接続</button>}</div></div>}
        {snapshot?.warning && <p role="alert" className="alert">{snapshot.warning.message}</p>}
        {state.pet.greeting && <p role="status" className="m">{state.pet.greeting}</p>}
        {showAdvanceNotice && <section className="advance-notice" aria-label="休憩の予告">
          <p className="sm" role="status">{state.advanceNotice!.text}</p>
        </section>}
        {state.bubble && <section aria-label="休憩のお知らせ" className="notice" data-emphasis={state.bubble.emphasis}>
          <p className="m">{state.bubble.text}</p>
          <p className="sm">「はい」でここまでの作業レポートを作成するよ。</p>
          <div className="bs"><button className="p" disabled={busy || state.bubble.disabled} onClick={() => { void actions.answer("yes"); }}>{state.bubble.yesLabel}</button><button disabled={busy || state.bubble.disabled} onClick={() => { void actions.answer("no"); }}>{state.bubble.noLabel}</button></div>
        </section>}
        {generating && <div role="status"><p className="m">ここまでの作業記録をまとめています。</p><div className="dots" aria-hidden="true"><span /><span /><span /></div></div>}
        {scheduled && <p role="status" className="sm">離席のレポートを予約しています。帰席しても予約は続きます。</p>}
        {panel !== "history" && <ReportPanel state={state.report} queuedCount={state.queuedReportCount} busy={busy || !running} onClose={state.queuedReportCount ? actions.closeReport : undefined} onRetry={() => retry()} />}
        {panel === "settings" && settings ? <>
          <SettingsPanel key={`${snapshot?.runtimeId}-${settings.revision}`} settings={settings} disabled={busy || running} onSave={actions.saveSettings} />
          {desktop && <label className="check"><input type="checkbox" checked={pinned} onChange={event => {
            const value = event.target.checked; setPinned(value); void actions.pinWindow(value);
          }} />ほかのウィンドウより手前に表示</label>}
          <div className="bs"><button onClick={reports}>記録を見る</button><button onClick={closePanel}>もどる</button></div>
          <details><summary>データ管理</summary><div className="bs"><button disabled={busy} onClick={() => { if (window.confirm("監視を停止し、履歴とレポートをすべて削除しますか？")) void actions.clearData(); }}>履歴とレポートを削除</button></div></details>
        </> : panel === "history" ? <>
          <ReportHistory key={snapshot?.runtimeId} state={state} actions={actions} busy={busy || !running} onRetry={retry} />
          <div className="bs"><button onClick={() => openPanel("menu")}>メニューへ</button></div>
        </> : panel === "menu" ? <>
          <p className="m">どうする？</p>
          <div className="menu-grid">
            <button className="menu-card p" disabled={busy} onClick={reports}><span aria-hidden="true">▤</span>作業記録を見る</button>
            {running ? <button className="menu-card" disabled={busy} onClick={() => { void actions.stop(); }}><span aria-hidden="true">Ⅱ</span>監視を停止</button>
              : <button className="menu-card" disabled={busy} onClick={() => openPanel("start")}><span aria-hidden="true">▷</span>作業を記録</button>}
            <button className="menu-card" onClick={actions.turn}><span aria-hidden="true">↻</span>ひとまわり</button>
            <button className="menu-card" disabled={!desktop} aria-pressed={pinned} onClick={togglePin}><span aria-hidden="true">◇</span>{pinned ? "最前面を解除" : "最前面に表示"}</button>
          </div>
          {desktop && <div className="menu-footer"><button className="quit-app" disabled={state.pending !== null} onClick={() => { void actions.closeApp(); }}>アプリを終了</button></div>}
        </> : !running && !reportOpen && !state.bubble && <>
          {panel === "start" && snapshot ? <section aria-label="監視の開始"><h3>今日は何から始める？</h3>
            {settings?.ocrEnabled && <p className="sm">OCR はオンです。AI 要約の作成時に全ウィンドウの文字を取得し、作業履歴と照合した文字を履歴と一緒に送信・カードに保存します。画像は保存・送信しません。ローカル履歴での開始では OCR を行いません。</p>}
            <label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{manual ? "手動の顔入力" : "カメラの顔の有無"}・PC 情報で在席を計測し、マスク済みの作業履歴を記録する</label>
            {usesAi ? <label className="check"><input type="checkbox" checked={externalConsent} onChange={event => setExternalConsent(event.target.checked)} />Yes の直後と離席確定の{profile === "demo" ? "5秒" : "5分"}後に、マスク済み履歴を {settings?.provider?.endpoint}（{settings?.provider?.model}）へ送信する</label> : <p className="sm">端末内で履歴カードを作成します。</p>}
            <div className="bs"><button className="p" disabled={busy || !consent || (!!usesAi && !externalConsent)} onClick={() => begin(!!usesAi)}>{usesAi ? "AI で開始" : "ローカル履歴で開始"}</button>{usesAi && <button disabled={busy || !consent} onClick={() => begin(false)}>AI 送信せず開始</button>}<button onClick={closePanel}>もどる</button></div>
          </section> : <><p className="m">タップして、今日の作業を始めよう</p><div className="bs"><button className="p" disabled={busy} onClick={() => setPanel("start")}>作業を記録</button><button onClick={() => setPanel("menu")}>メニュー</button></div></>}
        </>}
        {running && !state.bubble && !reportOpen && panel === "quiet" && quietMessage && <p className="m">記録をはじめたよ。ここで、待ってるね。</p>}
        <p className="status-line" role="status">{state.pet.statusText}</p>
        </div>
      </div>
      <button className={`chip${running || hideBubble ? " on" : ""}`} data-pochi-hit aria-label="作業メニューを開く" onClick={() => openPanel("menu")}>{running ? <><span className="timer-label">作業時間</span><time aria-label="連続在席時間">{duration(snapshot?.session?.elapsedMs ?? 0)}</time></> : state.pet.statusText}</button>
      <div className={`dwrap${state.motion.id === "rest" ? " lying" : ""}`}><span className="zz" aria-hidden="true">z z</span><button id="petbtn" data-pochi-hit="sprite" aria-label="ポチ：クリックで開始・メニュー、ダブルクリックで設定、ドラッグで移動"
        onPointerDown={event => {
          if (event.button !== 0) return;
          if (clickTimer.current) clearTimeout(clickTimer.current);
          drag.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={event => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId || start.moved || event.buttons !== 1) return;
          if (Math.hypot(event.screenX - start.x, event.screenY - start.y) < 6) return;
          start.moved = true;
          if (clickTimer.current) clearTimeout(clickTimer.current);
          void actions.moveWindow();
        }} onPointerUp={event => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={() => { if (drag.current) drag.current.moved = true; }}
        onClick={event => {
        if (clickTimer.current) clearTimeout(clickTimer.current);
        if (event.detail !== 0 && drag.current?.moved) return;
        if (event.detail > 1) return;
        if (event.detail === 0) tap(); else clickTimer.current = setTimeout(tap, 550);
      }} onDoubleClick={() => { if (drag.current?.moved) return; if (clickTimer.current) clearTimeout(clickTimer.current); openPanel("settings"); }}><PochiSprite motion={state.motion} reducedMotion={reduced} onComplete={actions.completeAnimation} /></button></div>
    </div>
  </main>;
}
