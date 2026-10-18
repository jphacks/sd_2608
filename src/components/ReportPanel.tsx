import type { ReportPanelProps } from "../contracts/ui.js";
import { reportStatusLabels } from "../presentation/reportLabels.js";

export function ReportPanel({ state, queuedCount, busy, onClose, onRetry }: ReportPanelProps) {
  if (state.phase === "closed") return null;
  return <section className="report-panel" aria-label="作業レポート" aria-live="polite">
    <h2>作業レポート</h2>
    {state.phase === "loading" && <p role="status">作業記録を読み込んでいます…</p>}
    {state.phase === "error" && <p role="alert">{state.error.message}</p>}
    {state.phase === "ready" && <>
      <p>{state.report.trigger === "away" ? "席を離れる前の作業記録" : "「レポートを作る」を選んだときの作業記録"} · {reportStatusLabels[state.report.status]}</p>
      {state.report.error && <p role="alert">{state.report.error.message}</p>}
      {state.report.content ? <>
        <p>{state.report.content.summary}</p>
        <h3>作業の振り返り</h3>
        <ul>{state.report.content.observedFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul>
        {state.report.content.nextAction && <p>次の作業の候補：{state.report.content.nextAction}</p>}
      </> : <p>AI 要約を含まない作業記録です。</p>}
      <details open={state.report.history.segments.length === 0}>
        <summary>記録した作業履歴（{state.report.history.segments.length}件）</summary>
        {state.report.history.segments.length === 0 ? <p>対象の履歴はありません。</p> :
          <ul>{state.report.history.segments.map(segment => <li key={segment.id}>{segment.appName}：{segment.maskedTitle}</li>)}</ul>}
      </details>
      {state.report.status === "failed" && <button disabled={busy} onClick={onRetry}>同じ履歴で再試行</button>}
      {state.report.history.ocr && <details><summary>作業履歴と照合した OCR（{state.report.history.ocr.windows.length}件）</summary>
        <p>取得日時：{new Date(state.report.history.ocr.capturedAt).toLocaleString("ja-JP")}。要約作成時点の文字で、作業履歴のウィンドウと照合した補足情報です。</p>
        <p>{state.report.history.ocr.unmatchedWindows}件は作業履歴と不一致、{state.report.history.ocr.unavailableWindows}件は取得できませんでした。</p>
        {!state.report.history.ocr.windows.length && <p>利用できる文字がないため、要約には作業履歴だけを使います。</p>}
        {state.report.history.ocr.windows.map((window, index) => <section key={index}><h3>{window.appName}：{window.maskedTitle}</h3><p>{window.text}</p></section>)}
      </details>}
    </>}
    {onClose && <button onClick={onClose}>{queuedCount ? `次の作業記録へ（残り${queuedCount}件）` : "閉じる"}</button>}
  </section>;
}
