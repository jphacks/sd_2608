import { useEffect, useState } from "react";
import type { AppViewProps } from "../contracts/ui.js";
import { PetStage } from "./PetStage.js";
import { MessageBubble } from "./MessageBubble.js";
import { ReportPanel } from "./ReportPanel.js";
import { SettingsPanel } from "./SettingsPanel.js";
import "../styles/app-view.css";

/** 表示担当はこのツリーを自由に置き換えられる。センサーや Gateway を直接 import しない。 */
export function AppView({ state, actions, petManifest }: AppViewProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [externalConsent, setExternalConsent] = useState(false);
  const snapshot = state.snapshot;
  const busy = state.pending !== null || state.connection !== "connected";
  const running = snapshot?.runtime.phase === "running";
  useEffect(() => {
    setConsent(false);
    setExternalConsent(false);
  }, [snapshot?.runtimeId, snapshot?.settings.revision, running]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else if (state.bubble && !busy) void actions.answer("no");
      else if (state.report.phase !== "closed") actions.closeReport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, state.bubble, state.report.phase, busy, actions]);
  const usesAi = snapshot?.settings.reportMode === "ai" && !!snapshot.settings.provider && snapshot.settings.hasApiKey;
  const destination = snapshot?.settings.provider;
  const retry = () => {
    if (snapshot?.runtime.effectiveReportMode === "ai" && destination && !window.confirm(
      `このレポートの固定済み履歴を次の AI へ再送信しますか？\n${destination.endpoint}\nモデル: ${destination.model}`,
    )) return;
    void actions.retryReport();
  };
  return <main className="app-view">
    <header><h1>休憩のおとも</h1><span>{state.connection === "connected" ? "接続済み" : state.connection === "connecting" ? "接続中" : "接続できません"}</span></header>
    {state.error && <p role="alert">{state.error.message} <button onClick={actions.dismissError}>閉じる</button></p>}
    {snapshot?.warning && <p role="alert">{snapshot.warning.message}</p>}
    <div className="pet-and-report">
      <div>
        <PetStage pet={state.pet} manifest={petManifest} reducedMotion={snapshot?.settings.reducedMotion ?? false} onClick={() => { void actions.openLatestReport(); }} />
        {state.bubble && <MessageBubble bubble={{ ...state.bubble, disabled: busy }} onAnswer={answer => { void actions.answer(answer); }} />}
      </div>
      <ReportPanel state={state.report} queuedCount={state.queuedReportCount} busy={busy || !running} onClose={actions.closeReport} onRetry={retry} />
    </div>
    {snapshot && <section className="runtime-controls" aria-label="取得・通知の操作">
      <p>連続在席：{Math.floor((snapshot.session?.elapsedMs ?? 0) / 60_000)}分 · 在席状態：{snapshot.presence.value}</p>
      {!running ? <>
        <label className="check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />顔の有無・PC 情報を使った計測と、マスク済み履歴の記録を開始する</label>
        {usesAi ? <label className="check"><input type="checkbox" checked={externalConsent} onChange={event => setExternalConsent(event.target.checked)} />Yes 時と離席5分後に、マスク済み履歴を {destination?.endpoint}（モデル: {destination?.model}）へ送信する</label> : <p>AI 送信を使わず、端末内の履歴カードを作成します。</p>}
        {snapshot.settings.reportMode === "ai" && !usesAi && <p>AI 要約には接続先・モデル・API キーの登録が必要です。</p>}
        <button disabled={busy || !consent || (usesAi && !externalConsent)} onClick={() => { void actions.start({
          profile: "normal", expectedSettingsRevision: snapshot.settings.revision,
          reportMode: usesAi ? "ai" : "local", consent: { activity: consent, history: consent, externalReport: usesAi && externalConsent },
        }); }}>{usesAi ? "AI で開始" : "ローカル履歴で開始"}</button>
        {usesAi && <button disabled={busy || !consent} onClick={() => { void actions.start({
          profile: "normal", expectedSettingsRevision: snapshot.settings.revision, reportMode: "local",
          consent: { activity: consent, history: consent, externalReport: false },
        }); }}>AI 送信せず開始</button>}
      </> : <button disabled={busy} onClick={() => { void actions.stop(); }}>監視を停止</button>}
      <button onClick={() => setSettingsOpen(value => !value)}>設定</button>
      {snapshot.jobs.some(job => job.status === "scheduled") && <p role="status">レポートを予約しています。帰席しても予約は継続します。</p>}
      {snapshot.jobs.some(job => job.status === "running" || job.status === "queued") && <p role="status">レポートを作成しています…</p>}
    </section>}
    {settingsOpen && snapshot && <SettingsPanel key={snapshot.settings.revision} settings={snapshot.settings} disabled={busy || running} onSave={actions.saveSettings} />}
    <section className="report-history" aria-label="保存したレポート">
      <h2>保存したレポート</h2>
      {state.reportListLoading && <p>読み込み中…</p>}
      {!state.reportListLoading && !state.reportList.length && <p>まだレポートはありません。</p>}
      <ul>{state.reportList.map(report => <li key={report.id}><button onClick={() => { void actions.openReport(report.id); }}>{new Date(report.createdAt).toLocaleTimeString("ja-JP")} · {report.status}</button></li>)}</ul>
      <button disabled={busy} onClick={() => { void actions.refreshReports(); }}>一覧を更新</button>
      <button disabled={busy} onClick={() => { if (window.confirm("履歴とレポートをすべて削除し、監視を停止しますか？")) void actions.clearData(); }}>履歴とレポートを削除</button>
    </section>
  </main>;
}
