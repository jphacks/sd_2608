import type { AppSnapshot, Report, ReportJobView } from "./domain.js";

export const FIXTURE_NOW = Date.UTC(2026, 9, 17, 0, 0);
export const MINUTE = 60_000;

export const scenarios = [
  { id: "stopped", label: "起動・停止中", description: "開始操作・設定・登場演出" },
  { id: "working", label: "作業中", description: "顔あり・連続在席29分" },
  { id: "uncertain", label: "顔が一時的に見えない", description: "通知を隠し、待機表現を確認" },
  { id: "reminder", label: "休憩しない？", description: "Yes／No を押して後続の状態へ" },
  { id: "snoozed", label: "No の延期中", description: "2分後から新しい区切り、10分後に再通知" },
  { id: "hardReminder", label: "60分の再通知", description: "強調表現と回答後の間隔" },
  { id: "awayScheduled", label: "離席・5分予約", description: "帰席しても予約は残る" },
  { id: "returnedWithPending", label: "帰席・旧予約あり", description: "新セッション中に旧レポートが完成" },
  { id: "generating", label: "生成中", description: "ローディング・操作抑制" },
  { id: "reportReady", label: "レポート完成", description: "自動表示・閉じる・再表示" },
  { id: "reportFailed", label: "レポート失敗", description: "エラー・履歴・明示的な再試行" },
  { id: "localReport", label: "ローカル履歴カード", description: "AI を利用しない場合" },
  { id: "emptyReport", label: "履歴なし", description: "空の履歴でもカードを表示" },
  { id: "multipleReports", label: "複数レポート完成", description: "完成順の表示キュー" },
  { id: "sensorError", label: "センサーエラー", description: "取得不能・案内・停止" },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];

/** 呼び出すごとに新しいオブジェクト。UI の編集を他の fixture に漏らさない。 */
export function createSnapshot(now = FIXTURE_NOW): AppSnapshot {
  return {
    apiVersion: 1, runtimeId: "mock-runtime", revision: 0, emittedAt: now,
    runtime: {
      phase: "stopped", trackingId: null, profile: "normal", effectiveReportMode: "local",
      camera: "off", activity: "off",
      consent: { activity: false, history: false, externalReport: false },
    },
    settings: {
      reportMode: "local", provider: null, excludedApps: [], reducedMotion: false,
      revision: 0, hasApiKey: false,
    },
    presence: { value: "unknown", reason: "sensorUnavailable", faceMissingSince: null, awayDetectedAt: null },
    session: null, reminder: null, jobs: [], completionSeq: 0, warning: null,
  };
}

export function createReport(id = "mock-report-1", sessionId = "mock-session-1", now = FIXTURE_NOW): Report {
  return {
    id, sessionId, trigger: "yes", createdAt: now, updatedAt: now, attempt: 1,
    status: "ready", error: null,
    history: {
      id: `history-${id}`, sessionId, capturedAt: now,
      rangeStart: now - 30 * MINUTE, rangeEnd: now,
      segments: [
        { id: `${id}-a`, sessionId, startedAt: now - 30 * MINUTE, endedAt: now - 10 * MINUTE,
          appName: "Code.exe", maskedTitle: "架空のプロジェクト — ペット UI" },
        { id: `${id}-b`, sessionId, startedAt: now - 10 * MINUTE, endedAt: now,
          appName: "msedge.exe", maskedTitle: "架空の設計メモ — 状態遷移" },
      ],
    },
    content: {
      summary: "ペットの表示を調整し、状態遷移を確認しました。これは開発用の固定応答です。",
      observedFacts: ["Code.exe の架空のプロジェクトが前面にありました。", "ブラウザーで架空の設計メモを開いていました。"],
      nextAction: "休憩後はレポートカードの表示を確認する。",
    },
  };
}

export function createJob(report: Report, status: ReportJobView["status"] = "ready"): ReportJobView {
  return {
    id: report.id, sessionId: report.sessionId, trigger: report.trigger,
    requestedAt: report.createdAt, dueAt: report.createdAt, status,
    attempt: report.attempt, completionSeq: null,
  };
}
