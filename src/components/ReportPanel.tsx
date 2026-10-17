import type { ReportPanelProps } from "../contracts/ui.js";

export function ReportPanel({ state, queuedCount, busy, onClose, onRetry }: ReportPanelProps) {
  if (state.phase === "closed") return null;
  return <section className="report-panel" aria-label="作業レポート" aria-live="polite">
    <h2>作業レポート</h2>
    {state.phase === "loading" && <p role="status">カードを読み込んでいます…</p>}
    {state.phase === "error" && <p role="alert">{state.error.message}</p>}
    {state.phase === "ready" && <>
      <p>{state.report.trigger === "away" ? "自然離席" : "Yes の選択"}から作成 · {state.report.status}</p>
      {state.report.error && <p role="alert">{state.report.error.message}</p>}
      {state.report.content ? <>
        <p>{state.report.content.summary}</p>
        <h3>AI が挙げた内容</h3>
        <ul>{state.report.content.observedFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
        {state.report.content.nextAction && <p>次の作業の候補：{state.report.content.nextAction}</p>}
      </> : <p>AI 要約のない履歴カードです。</p>}
      <details open={state.report.history.segments.length === 0}>
        <summary>根拠となる履歴（{state.report.history.segments.length}区間）</summary>
        {state.report.history.segments.length === 0 ? <p>対象の履歴はありません。</p> :
          <ul>{state.report.history.segments.map(segment => <li key={segment.id}>{segment.appName}：{segment.maskedTitle}</li>)}</ul>}
      </details>
      {state.report.status === "failed" && <button disabled={busy} onClick={onRetry}>同じ履歴で再試行</button>}
    </>}
    <button onClick={onClose}>{queuedCount ? `次のカードへ（残り${queuedCount}件）` : "閉じる"}</button>
  </section>;
}
