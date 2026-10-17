// Rust DTO と共有する通信契約。変更時は docs/data-model.md も更新する。
export type TimestampMs = number;
export type DurationMs = number;
export type Id = string;
export type TimingProfile = "normal" | "demo";
export type Presence = "present" | "uncertain" | "away" | "unknown";
export type PresenceReason =
  | "stableFace" | "stabilizing" | "faceMissing" | "awayConfirmed"
  | "missingInput" | "sensorUnavailable" | "staleSample" | "protectedScreen";

export type WindowInfo = {
  windowId: Id;
  processId: number;
  appName: string;
  windowTitle: string; // 履歴へ渡す前にマスク。Console に出さない
};
export type Foreground =
  | { kind: "external"; window: WindowInfo }
  | { kind: "pet" | "excluded" | "restricted" | "unavailable" };
export type ActivitySample = {
  observedAt: TimestampMs;
  idleMs: DurationMs | null;
  foreground: Foreground;
};
export type FaceInput = {
  trackingId: Id;
  sequence: number; // trackingId ごとに増加
  observedAt: TimestampMs;
  source: "camera" | "manual";
} & (
  | { kind: "sample"; faceDetected: boolean }
  | { kind: "unavailable"; reason: "denied" | "stopped" | "deviceError" }
);
export type PresenceState = {
  value: Presence;
  reason: PresenceReason;
  faceMissingSince: TimestampMs | null;
  awayDetectedAt: TimestampMs | null; // 30秒の条件を満たして確定した時刻
};
export type SittingSession = {
  id: Id;
  startedAt: TimestampMs;
  endedAt: TimestampMs | null;
  endReason: "away" | "interrupted" | "stopped" | null;
  elapsedMs: DurationMs; // 単調時計で算出した連続時間
  reportJobId: Id | null;
};
export type Boundary = {
  id: Id;
  occurredAt: TimestampMs;
  kind: "idle" | "windowSwitchIdle";
};
export type Reminder = {
  id: Id;
  sessionId: Id;
  source: "sitting"; // 将来は独立した通知型を union で追加
  level: "normal" | "hard";
  cause: "boundary" | "initialLimit" | "snoozeLimit" | "hardLimit";
  shownAt: TimestampMs;
};
export type AdvanceNotice = {
  sessionId: Id;
  remainingMs: DurationMs; // 最初の休憩目安まで。Rust の単調時計で算出する。
};
export type ReminderPolicyState = {
  active: Reminder | null;
  eligibleAt: TimestampMs | null;
  latestAt: TimestampMs | null;
  lastConsumedBoundaryId: Id | null;
  lastAnswer: "yes" | "no" | null;
  lastAnsweredAt: TimestampMs | null;
  hardNextAt: TimestampMs | null;
};

export type ActivitySegment = {
  id: Id;
  sessionId: Id;
  startedAt: TimestampMs;
  endedAt: TimestampMs;
  appName: string;
  maskedTitle: string;
};
export type HistorySnapshot = {
  id: Id;
  sessionId: Id;
  capturedAt: TimestampMs;
  rangeStart: TimestampMs;
  rangeEnd: TimestampMs;
  segments: ActivitySegment[];
};
export type ReportTrigger = "yes" | "away";
export type JobStatus =
  | "scheduled" | "queued" | "running" | "ready" | "failed" | "cancelled";
export type ReportJobView = {
  id: Id; // 完成カードの reportId も同じ値を使う
  sessionId: Id;
  trigger: ReportTrigger;
  requestedAt: TimestampMs;
  dueAt: TimestampMs;
  status: JobStatus;
  attempt: number;
  completionSeq: number | null;
};
export type ReportContent = {
  summary: string;
  observedFacts: string[]; // AI が挙げた内容。根拠の履歴と併記
  nextAction: string | null;
};
export type Report = {
  id: Id;
  sessionId: Id;
  trigger: ReportTrigger;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  attempt: number;
  status: "ready" | "failed" | "local";
  history: HistorySnapshot;
  content: ReportContent | null;
  error: ApiError | null;
};
export type ProviderSettings = {
  kind: "gemini" | "openAiCompatible";
  endpoint: string;
  model: string;
};
export type SettingsInput = {
  reportMode: "local" | "ai";
  provider: ProviderSettings | null;
  excludedApps: string[];
  reducedMotion: boolean;
};
export type SettingsView = SettingsInput & {
  revision: number;
  hasApiKey: boolean;
};
export type KeyChange =
  | { kind: "keep" }
  | { kind: "replace"; value: string }
  | { kind: "remove" };
export type RuntimeState = {
  phase: "stopped" | "starting" | "running" | "stopping" | "error";
  trackingId: Id | null;
  profile: TimingProfile;
  effectiveReportMode: "local" | "ai";
  camera: "off" | "waiting" | "running" | "error";
  activity: "off" | "running" | "error";
  consent: { activity: boolean; history: boolean; externalReport: boolean };
};
export type AppSnapshot = {
  apiVersion: 1;
  runtimeId: Id; // Rust プロセス起動ごとに変わる
  revision: number;
  emittedAt: TimestampMs;
  runtime: RuntimeState;
  settings: SettingsView;
  presence: PresenceState;
  session: SittingSession | null;
  reminder: Reminder | null;
  advanceNotice: AdvanceNotice | null;
  jobs: ReportJobView[];
  completionSeq: number;
  warning: ApiError | null;
};
export type ErrorCode =
  | "validation" | "invalidState" | "staleRevision" | "staleTracking"
  | "staleReminder" | "notFound" | "consentRequired" | "providerNotConfigured"
  | "permissionDenied" | "storageFailure" | "networkFailure" | "timeout"
  | "invalidResponse" | "cancelled" | "internal";
export type ApiError = { code: ErrorCode; message: string; retryable: boolean };
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };
