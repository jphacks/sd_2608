import { useEffect, useState } from "react";
import type { AppViewActions, AppViewModel, ReportPanelState } from "../contracts/ui.js";
import { ReportPanel } from "./ReportPanel.js";

const reportId = (report: ReportPanelState) => report.phase === "closed" ? null
  : report.phase === "ready" ? report.report.id : report.reportId;

/** 最新カードを上に開き、過去のカードは開いたときに読み込む。 */
export function ReportHistory({ state, actions, busy, onRetry }: {
  state: AppViewModel; actions: AppViewActions; busy: boolean; onRetry(id: string): void;
}) {
  const [cache, setCache] = useState<Record<string, ReportPanelState>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const currentId = reportId(state.report);
  const latestId = state.reportList[0]?.id;
  useEffect(() => {
    if (currentId && (state.report.phase === "ready" || state.report.phase === "error")) {
      setCache(previous => ({ ...previous, [currentId]: state.report }));
    }
  }, [currentId, state.report]);
  useEffect(() => {
    // 履歴画面を開いている間に新しいレポートが完成した場合も、先頭を読み込む。
    if (latestId && currentId !== latestId && !cache[latestId]
      && !state.reportListLoading && state.report.phase !== "loading") void actions.openReport(latestId);
  }, [latestId, currentId, cache, state.reportListLoading, state.report.phase, actions]);
  const content = (id: string) => <ReportPanel
    state={currentId === id ? state.report : cache[id] ?? { phase: "loading", reportId: id }}
    queuedCount={0} busy={busy} onRetry={() => onRetry(id)} />;
  return <section className="report-history" aria-label="保存したレポート">
    <h3>最新の作業記録</h3>
    {state.reportListLoading && <p role="status" className="sm">読み込み中…</p>}
    {!state.reportListLoading && !latestId && <p className="sm">まだレポートはありません。</p>}
    {latestId && content(latestId)}
    <h3>すべての作業履歴</h3>
    <ul className="report-list">{state.reportList.map(report => <li key={report.id}>
      <details open={expanded === report.id}>
        <summary onClick={event => {
          event.preventDefault();
          const open = expanded !== report.id;
          setExpanded(open ? report.id : null);
          if (open) void actions.openReport(report.id);
        }}>{new Date(report.createdAt).toLocaleString("ja-JP")} · {report.status}</summary>
        {expanded === report.id && content(report.id)}
      </details>
    </li>)}</ul>
    <div className="bs"><button disabled={busy} onClick={() => { void actions.openLatestReport(); }}>一覧を更新</button></div>
  </section>;
}
