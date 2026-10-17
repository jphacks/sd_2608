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

/** A の表示。計時・休憩判定・保存は AppController と Gateway に委譲する。 */
export default function PochiApp({ state, actions, desktop = false, profile = "normal", manual = false }: AppViewProps & {
  desktop?: boolean; profile?: TimingProfile; manual?: boolean;
}) {
  const [panel, setPanel] = useState<"home" | "start" | "settings" | "history">("home");
  const [consent, setConsent] = useState(false);
  const [externalConsent, setExternalConsent] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshot = state.snapshot;
  const running = snapshot?.runtime.phase === "running";
  const busy = state.pending !== null || state.connection !== "connected";
  const settings = snapshot?.settings;
  const usesAi = settings?.reportMode === "ai" && !!settings.provider && settings.hasApiKey;
  const reportOpen = state.report.phase !== "closed";
  const generating = snapshot?.jobs.some(job => job.status === "running" || job.status === "queued");
  useEffect(() => {
    setConsent(false); setExternalConsent(false);
    if (running) setPanel("home");
  }, [snapshot?.runtimeId, settings?.revision, running]);
  useEffect(() => {
    document.documentElement.dataset.pochiDesktop = String(desktop);
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduced(media.matches);
    media.addEventListener("change", change);
    return () => { media.removeEventListener("change", change); delete document.documentElement.dataset.pochiDesktop;
      if (clickTimer.current) clearTimeout(clickTimer.current); };
  }, [desktop]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panel !== "home") setPanel("home");
      else if (state.bubble && !busy) void actions.answer("no");
      else if (reportOpen) actions.closeReport();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [actions, state.bubble, reportOpen, busy, panel]);
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
  const tap = () => { if (running) void actions.openLatestReport(); else setPanel("start"); };
  return <main className="pochi-app">
    {!desktop && <header className="pochi-page-header"><a href="#" onClick={event => { event.preventDefault(); setPanel("home"); }}><span className="pochi-logo">ぽ</span> ポチ <small>休憩のおとも</small></a><span className="pochi-pill">表示開発</span></header>}
    <section className="pochi-room" aria-label="ポチとの作業スペース">
      {!desktop && <div className="pochi-intro"><span className="pochi-eyebrow">ひと息、つこう。</span><h1>小さな休憩を、<br />いっしょに。</h1><p>がんばる時間も、休む時間も。<br />ポチがそっと寄り添います。</p></div>}
      <div className="pochi-dock">
        <div className={`pochi-bubble ${reportOpen ? "pochi-bubble--report" : ""}`} aria-label="ポチのメニュー">
          <span className="pochi-pill">{state.connection === "connected" ? profile === "demo" ? `短縮デモ · ${manual ? "手動顔入力" : "実カメラ"}` : "接続済み" : state.connection === "connecting" ? "接続中" : "接続できません"}</span>
          {state.connection === "error" && !state.error && <button onClick={() => { void actions.reconnect(); }}>再接続</button>}
          {state.error && <div role="alert" className="pochi-alert">{state.error.message}<div className="pochi-actions"><button onClick={actions.dismissError}>閉じる</button>{state.connection === "error" && <button onClick={() => { void actions.reconnect(); }}>再接続</button>}</div></div>}
          {snapshot?.warning && <p role="alert" className="pochi-alert">{snapshot.warning.message}</p>}
          {state.pet.greeting && <p role="status">{state.pet.greeting}</p>}
          {state.bubble && <section aria-label="休憩のお知らせ" className="pochi-alert" data-emphasis={state.bubble.emphasis}>
            <span className="pochi-eyebrow">ひと息の時間</span><h2>少し立って、<br />休憩しない？</h2><p>{state.bubble.text}</p>
            <p className="pochi-muted">「はい」でここまでの作業レポートを作成するよ。</p>
            <div className="pochi-actions"><button className="pochi-primary" disabled={busy || state.bubble.disabled} onClick={() => { void actions.answer("yes"); }}>{state.bubble.yesLabel}</button><button disabled={busy || state.bubble.disabled} onClick={() => { void actions.answer("no"); }}>{state.bubble.noLabel}</button></div>
          </section>}
          {generating && <p role="status">ここまでのレポートを作成しているよ…</p>}
          {snapshot?.jobs.some(job => job.status === "scheduled") && <p role="status">離席のレポートを予約しています。帰席しても予約は続きます。</p>}
          <ReportPanel state={state.report} queuedCount={state.queuedReportCount} busy={busy || !running} onClose={actions.closeReport} onRetry={retry} />
          {panel === "settings" && settings ? <>
            <SettingsPanel key={`${snapshot?.runtimeId}-${settings.revision}`} settings={settings} disabled={busy || running} onSave={actions.saveSettings} />
            {desktop && <label className="pochi-check"><input type="checkbox" checked={pinned} onChange={event => {
              const value = event.target.checked; setPinned(value); void actions.pinWindow(value);
            }} />ほかのウィンドウより手前に表示</label>}
            <button onClick={() => setPanel("home")}>もどる</button>
            <button disabled={busy} onClick={() => { if (window.confirm("監視を停止し、履歴とレポートをすべて削除しますか？")) void actions.clearData(); }}>履歴とレポートを削除</button>
          </> : panel === "history" ? <section aria-label="保存したレポート"><h2>作業のふりかえり</h2>
            {state.reportListLoading && <p role="status">読み込み中…</p>}
            {!state.reportListLoading && !state.reportList.length && <p>まだレポートはありません。</p>}
            <ul>{state.reportList.map(report => <li key={report.id}><button onClick={() => { void actions.openReport(report.id); }}>{new Date(report.createdAt).toLocaleString("ja-JP")} · {report.status}</button></li>)}</ul>
            <div className="pochi-actions"><button disabled={busy} onClick={() => { void actions.refreshReports(); }}>一覧を更新</button><button onClick={() => setPanel("home")}>もどる</button></div>
          </section> : !running && !reportOpen && <>
            <span className="pochi-eyebrow">こんにちは</span><h2>今日も、いっしょに。</h2>
            {panel === "start" && snapshot ? <section aria-label="監視の開始">
              <label className="pochi-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />{manual ? "手動の顔入力" : "カメラの顔の有無"}・PC 情報で在席を計測し、マスク済みの作業履歴を記録する</label>
              {usesAi ? <label className="pochi-check"><input type="checkbox" checked={externalConsent} onChange={event => setExternalConsent(event.target.checked)} />Yes の直後と離席確定の{profile === "demo" ? "5秒" : "5分"}後に、マスク済み履歴を {settings?.provider?.endpoint}（{settings?.provider?.model}）へ送信する</label> : <p className="pochi-muted">端末内で履歴カードを作成します。</p>}
              <button className="pochi-primary pochi-full" disabled={busy || !consent || (!!usesAi && !externalConsent)} onClick={() => begin(!!usesAi)}>{usesAi ? "AI で開始" : "ローカル履歴で開始"}</button>
              {usesAi && <button disabled={busy || !consent} onClick={() => begin(false)}>AI 送信せず開始</button>}
            </section> : <><p>今日は何をしようか？</p><button className="pochi-primary pochi-full" onClick={() => setPanel("start")} disabled={busy}>作業を記録</button></>}
          </>}
          {running && !state.bubble && !reportOpen && panel === "home" && <><span className="pochi-eyebrow">作業中</span><h2>ここで、待ってるね。</h2><p>{state.pet.statusText}</p><button onClick={() => { void actions.openLatestReport(); }}>最新のレポートを見る</button></>}
        </div>
        <div className="pochi-pet-row"><button className="pochi-pet-button" style={{ width: 230, height: 230 }} aria-label="ポチ：クリックで開始・レポート、ダブルクリックで設定" onClick={event => {
          if (clickTimer.current) clearTimeout(clickTimer.current);
          if (event.detail > 1) return;
          if (event.detail === 0) tap(); else clickTimer.current = setTimeout(tap, 550);
        }} onDoubleClick={() => { if (clickTimer.current) clearTimeout(clickTimer.current); setPanel("settings"); }}><PochiSprite motion={state.motion} reducedMotion={settings?.reducedMotion || systemReduced} onComplete={actions.completeAnimation} /></button></div>
        <div className="pochi-status" role="status"><span className={`pochi-status-dot ${snapshot?.presence.value === "away" ? "is-resting" : ""}`} /><span>{state.pet.statusText}</span><time aria-label="連続在席時間">{duration(snapshot?.session?.elapsedMs ?? 0)}</time></div>
        <nav className="pochi-toolbar" aria-label="ポチの操作"><button onClick={() => setPanel("settings")}>設定</button><button onClick={() => { setPanel("history"); void actions.refreshReports(); }}>記録</button><button onClick={actions.turn}>ひとまわり</button>{running && <button disabled={busy} onClick={() => { void actions.stop(); }}>監視を停止</button>}{desktop && <><button aria-label="ウィンドウを移動" onPointerDown={event => { if (event.button === 0) void actions.moveWindow(); }}>移動</button><button disabled={state.pending !== null} onClick={() => { void actions.closeApp(); }}>終了</button></>}</nav>
        <p className="pochi-hint">クリックで開始・レポート · ダブルクリックで設定</p>
      </div>
    </section>
  </main>;
}
