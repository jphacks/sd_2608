import { useEffect, useRef, useState } from "react";
import type { AppViewProps } from "../contracts/ui.js";
import type { TimingProfile } from "../contracts/domain.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { ReportPanel } from "../components/ReportPanel.js";
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
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshot = state.snapshot;
  const running = snapshot?.runtime.phase === "running";
  const busy = state.pending !== null || state.connection !== "connected";
  const settings = snapshot?.settings;
  const usesAi = settings?.reportMode === "ai" && !!settings.provider && settings.hasApiKey;
  const reportOpen = state.report.phase !== "closed";
  const generating = snapshot?.jobs.some(job => job.status === "running" || job.status === "queued");
  const scheduled = snapshot?.jobs.some(job => job.status === "scheduled");
  const reduced = !!settings?.reducedMotion || systemReduced;
  // 消してよいのは作業開始の案内だけ。通知・エラー・完成カードは常に優先する。
  const attention = state.connection !== "connected" || !!state.error || !!snapshot?.warning || !!state.bubble || reportOpen || generating || scheduled;
  const hideBubble = panel === "quiet" && !quietMessage && !attention;
  useEffect(() => {
    setConsent(false); setExternalConsent(false);
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
  const closePanel = () => setPanel(running ? "quiet" : "home");
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panel !== "home" && panel !== "quiet") setPanel(running ? "quiet" : "home");
      else if (state.bubble && !busy) void actions.answer("no");
      else if (reportOpen) actions.closeReport();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [actions, state.bubble, reportOpen, busy, panel, running]);
  const begin = (ai: boolean) => {
    if (!snapshot || !consent || (ai && !externalConsent)) return;
    void actions.start({ profile, expectedSettingsRevision: snapshot.settings.revision, reportMode: ai ? "ai" : "local",
      consent: { activity: true, history: true, externalReport: ai && externalConsent } });
  };
  const retry = () => {
    if (snapshot?.runtime.effectiveReportMode === "ai" && settings?.provider && !window.confirm(
      `このレポートの固定済み履歴を次の AI へ再送信しますか？\n${settings.provider.endpoint}\nモデル: ${settings.provider.model}`,
    )) return;
    void actions.retryReport();
  };
  const reports = () => { setPanel("history"); void actions.refreshReports(); };
  const tap = () => setPanel(running ? "menu" : "start");
  const appOperations = <details className="pet-actions"><summary>その他の操作</summary><div className="bs">
    <button onClick={actions.turn}>ひとまわり</button>
    <button disabled={busy} onClick={() => { void actions.openLatestReport(); }}>最新のレポートを見る</button>
    {desktop && <><button className="drag" aria-label="ウィンドウを移動" onPointerDown={event => { if (event.button === 0) void actions.moveWindow(); }}>ウィンドウを移動</button><button disabled={state.pending !== null} onClick={() => { void actions.closeApp(); }}>アプリを終了</button></>}
  </div></details>;
  return <main className="pochi-app" data-reduced-motion={reduced} aria-label="ポチ">
    <div className="pet">
      <div className={`bub${panel === "settings" ? " wide" : ""}`} role="dialog" aria-label={panel === "settings" ? "ポチの設定" : "ポチのふきだし"} aria-live="polite" hidden={hideBubble}>
        <div className="bub-body">
        {state.connection !== "connected" && <p className="sm" role="status">{state.connection === "connecting" ? "アプリへ接続しています…" : "アプリへ接続できません。"}</p>}
        {state.connection === "error" && !state.error && <div className="bs"><button onClick={() => { void actions.reconnect(); }}>再接続</button></div>}
        {profile === "demo" && <p className="sm">短縮デモ · {manual ? "手動顔入力（実カメラ不使用）" : "実カメラ"}</p>}
        {state.error && <div role="alert" className="alert">{state.error.message}<div className="bs"><button onClick={actions.dismissError}>エラーを閉じる</button>{state.connection === "error" && <button onClick={() => { void actions.reconnect(); }}>再接続</button>}</div></div>}
        {snapshot?.warning && <p role="alert" className="alert">{snapshot.warning.message}</p>}
        {state.pet.greeting && <p role="status" className="m">{state.pet.greeting}</p>}
        {state.bubble && <section aria-label="休憩のお知らせ" className="notice" data-emphasis={state.bubble.emphasis}>
          <p className="m">{state.bubble.text}</p>
          <p className="sm">「はい」でここまでの作業レポートを作成するよ。</p>
          <div className="bs"><button className="p" disabled={busy || state.bubble.disabled} onClick={() => { void actions.answer("yes"); }}>{state.bubble.yesLabel}</button><button disabled={busy || state.bubble.disabled} onClick={() => { void actions.answer("no"); }}>{state.bubble.noLabel}</button></div>
        </section>}
        {generating && <div role="status"><p className="m">ここまでの作業記録をまとめています。</p><div className="dots" aria-hidden="true"><span /><span /><span /></div></div>}
        {scheduled && <p role="status" className="sm">離席のレポートを予約しています。帰席しても予約は続きます。</p>}
        <ReportPanel state={state.report} queuedCount={state.queuedReportCount} busy={busy || !running} onClose={actions.closeReport} onRetry={retry} />
        {panel === "settings" && settings ? <>
          <SettingsPanel key={`${snapshot?.runtimeId}-${settings.revision}`} settings={settings} disabled={busy || running} onSave={actions.saveSettings} />
          {desktop && <label className="check"><input type="checkbox" checked={pinned} onChange={event => {
            const value = event.target.checked; setPinned(value); void actions.pinWindow(value);
          }} />ほかのウィンドウより手前に表示</label>}
          <div className="bs"><button onClick={reports}>記録を見る</button><button onClick={closePanel}>もどる</button></div>
          <details><summary>データ管理</summary><div className="bs"><button disabled={busy} onClick={() => { if (window.confirm("監視を停止し、履歴とレポートをすべて削除しますか？")) void actions.clearData(); }}>履歴とレポートを削除</button></div></details>
          {appOperations}
        </> : panel === "history" ? <section aria-label="保存したレポート"><h3>作業のふりかえり</h3>
          {state.reportListLoading && <p role="status" className="sm">読み込み中…</p>}
          {!state.reportListLoading && !state.reportList.length && <p className="sm">まだレポートはありません。</p>}
          <ul className="report-list">{state.reportList.map(report => <li key={report.id}><button onClick={() => { void actions.openReport(report.id); }}>{new Date(report.createdAt).toLocaleString("ja-JP")} · {report.status}</button></li>)}</ul>
          <div className="bs"><button disabled={busy} onClick={() => { void actions.refreshReports(); }}>一覧を更新</button><button onClick={closePanel}>もどる</button></div>
        </section> : panel === "menu" ? <>
          <p className="m">どうする？</p>
          <div className="bs"><button className="p" onClick={reports}>作業記録を見る</button><button onClick={() => setPanel("settings")}>設定</button>{running ? <button disabled={busy} onClick={() => { void actions.stop(); }}>監視を停止</button> : <button disabled={busy} onClick={() => setPanel("start")}>作業を記録</button>}<button onClick={closePanel}>なんでもない</button></div>
          {appOperations}
        </> : !running && !reportOpen && !state.bubble && <>
          {panel === "start" && snapshot ? <section aria-label="監視の開始"><h3>今日は何から始める？</h3>
            <label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{manual ? "手動の顔入力" : "カメラの顔の有無"}・PC 情報で在席を計測し、マスク済みの作業履歴を記録する</label>
            {usesAi ? <label className="check"><input type="checkbox" checked={externalConsent} onChange={event => setExternalConsent(event.target.checked)} />Yes の直後と離席確定の{profile === "demo" ? "5秒" : "5分"}後に、マスク済み履歴を {settings?.provider?.endpoint}（{settings?.provider?.model}）へ送信する</label> : <p className="sm">端末内で履歴カードを作成します。</p>}
            <div className="bs"><button className="p" disabled={busy || !consent || (!!usesAi && !externalConsent)} onClick={() => begin(!!usesAi)}>{usesAi ? "AI で開始" : "ローカル履歴で開始"}</button>{usesAi && <button disabled={busy || !consent} onClick={() => begin(false)}>AI 送信せず開始</button>}<button onClick={closePanel}>もどる</button></div>
          </section> : <><p className="m">タップして、今日の作業を始めよう</p><div className="bs"><button className="p" disabled={busy} onClick={() => setPanel("start")}>作業を記録</button><button onClick={() => setPanel("menu")}>メニュー</button></div></>}
        </>}
        {running && !state.bubble && !reportOpen && panel === "quiet" && quietMessage && <p className="m">記録をはじめたよ。ここで、待ってるね。</p>}
        <p className="status-line" role="status">{state.pet.statusText}{running && <> · <time aria-label="連続在席時間">{duration(snapshot?.session?.elapsedMs ?? 0)}</time></>}</p>
        </div>
      </div>
      <button className={`chip${hideBubble ? " on" : ""}`} aria-label="作業メニューを開く" onClick={() => setPanel("menu")}>{state.pet.statusText}{running && <> · {duration(snapshot?.session?.elapsedMs ?? 0)}</>}</button>
      <button className="gear" aria-label="設定" onClick={() => setPanel("settings")}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.4 1a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 2.2 1.3L10 21h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z" /></svg></button>
      <div className={`dwrap${state.motion.id === "rest" ? " lying" : ""}`}><span className="zz" aria-hidden="true">z z</span><button id="petbtn" aria-label="ポチ：クリックで開始・メニュー、ダブルクリックで設定" onClick={event => {
        if (clickTimer.current) clearTimeout(clickTimer.current);
        if (event.detail > 1) return;
        if (event.detail === 0) tap(); else clickTimer.current = setTimeout(tap, 550);
      }} onDoubleClick={() => { if (clickTimer.current) clearTimeout(clickTimer.current); setPanel("settings"); }}><PochiSprite motion={state.motion} reducedMotion={reduced} onComplete={actions.completeAnimation} /></button></div>
    </div>
  </main>;
}
