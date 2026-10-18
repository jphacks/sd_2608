import type { AppGateway } from "../../ports/AppGateway.js";
import type {
  ApiResult, AppSnapshot, Id, Presence, Report, ReportJobView,
} from "../../contracts/domain.js";
import type {
  ListReportsRequest, ReportPage, RespondReminderRequest, RespondReminderResult,
  RetryReportRequest, StartRuntimeRequest, UpdateSettingsRequest,
} from "../../contracts/api.js";
import { createJob, createReport, createSnapshot, FIXTURE_NOW, MINUTE } from "../../contracts/fixtures.js";
import type { ScenarioId } from "../../contracts/fixtures.js";

const copy = <T>(value: T): T => structuredClone(value);
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data: copy(data) });
const fail = <T>(code: "invalidState" | "staleTracking" | "staleReminder" | "staleRevision" |
  "validation" | "notFound" | "consentRequired" | "providerNotConfigured", message: string): ApiResult<T> =>
  ({ ok: false, error: { code, message, retryable: false } });

/** UI 開発専用。センサー推定・HTTP・永続化を行わない、手動時計のシナリオ実行器。 */
export class MockGateway implements AppGateway {
  private snapshot = createSnapshot();
  private reports = new Map<Id, Report>();
  private listeners = new Set<(state: AppSnapshot) => void>();
  private now = FIXTURE_NOW;
  private serial = 0;
  private nextPromptAt = Infinity;
  private nextPromptCause: "initialLimit" | "snoozeLimit" = "initialLimit";
  private boundaryEligibleAt = Infinity;
  private hardNextAt = -Infinity;
  private generationFailures = new Set<Id>();

  async connect(listener: (state: AppSnapshot) => void): Promise<AppSnapshot> {
    this.listeners.add(listener);
    return copy(this.snapshot);
  }
  async dispose(): Promise<void> { this.listeners.clear(); }
  getSnapshot(): AppSnapshot { return copy(this.snapshot); }
  private id(prefix: string): Id { return `mock-${prefix}-${++this.serial}`; }
  private unit(): number { return this.snapshot.runtime.profile === "demo" ? 1_000 : MINUTE; }
  private emit(): void {
    const { session, runtime, presence } = this.snapshot;
    const remaining = 30 * this.unit() - (session?.elapsedMs ?? 0);
    this.snapshot.advanceNotice = runtime.phase === "running" && presence.value === "present"
      && session?.endedAt === null && remaining > 0 && remaining <= 3 * this.unit()
      ? { sessionId: session.id, remainingMs: remaining } : null;
    this.snapshot.revision++;
    this.snapshot.emittedAt = this.now;
    for (const listener of this.listeners) listener(copy(this.snapshot));
  }
  private beginSession(elapsed = 0): void {
    this.snapshot.session = {
      id: this.id("session"), startedAt: this.now - elapsed, endedAt: null,
      endReason: null, elapsedMs: elapsed, reportJobId: null,
    };
    this.nextPromptAt = this.now - elapsed + 35 * this.unit();
    this.nextPromptCause = "initialLimit";
    this.boundaryEligibleAt = this.now - elapsed + 30 * this.unit();
    this.hardNextAt = -Infinity;
  }
  private showReminder(cause: "boundary" | "initialLimit" | "snoozeLimit" | "hardLimit"): void {
    const session = this.snapshot.session;
    if (!session || this.snapshot.reminder) return;
    this.snapshot.reminder = {
      id: this.id("reminder"), sessionId: session.id, source: "sitting",
      level: session.elapsedMs >= 60 * this.unit() ? "hard" : "normal",
      cause, shownAt: this.now,
    };
  }

  async start(input: Omit<StartRuntimeRequest, "requestId">): Promise<ApiResult<AppSnapshot>> {
    if (this.snapshot.runtime.phase !== "stopped") return fail("invalidState", "先に作業の記録を停止してください。");
    if (input.expectedSettingsRevision !== this.snapshot.settings.revision) return fail("staleRevision", "設定を読み直してください。");
    if (!input.consent.activity || !input.consent.history || (input.reportMode === "ai" && !input.consent.externalReport))
      return fail("consentRequired", "開始する機能の説明を確認してください。");
    if (input.reportMode === "ai" && (!this.snapshot.settings.provider || !this.snapshot.settings.hasApiKey))
      return fail("providerNotConfigured", "AI 設定がありません。ローカルモードを選べます。");
    this.snapshot.runtime = {
      phase: "running", trackingId: this.id("tracking"), profile: input.profile,
      effectiveReportMode: input.reportMode, camera: "running", activity: "running", consent: copy(input.consent),
    };
    this.snapshot.presence = { value: "present", reason: "stableFace", faceMissingSince: null, awayDetectedAt: null };
    this.snapshot.warning = null;
    this.beginSession();
    this.emit();
    return ok(this.snapshot);
  }
  async stop(trackingId: Id): Promise<ApiResult<AppSnapshot>> {
    if (trackingId !== this.snapshot.runtime.trackingId) return fail("staleTracking", "記録の状態が変わりました。もう一度操作してください。");
    this.stopRuntime();
    this.emit();
    return ok(this.snapshot);
  }
  private stopRuntime(): void {
    this.snapshot.runtime = { ...createSnapshot(this.now).runtime, profile: this.snapshot.runtime.profile };
    this.snapshot.presence = createSnapshot(this.now).presence;
    this.snapshot.session = null;
    this.snapshot.reminder = null;
    this.nextPromptAt = this.boundaryEligibleAt = Infinity;
    for (const job of this.snapshot.jobs) {
      if (["scheduled", "queued", "running"].includes(job.status)) job.status = "cancelled";
    }
  }

  async respond(input: Omit<RespondReminderRequest, "requestId">): Promise<ApiResult<RespondReminderResult>> {
    const { session, reminder, runtime } = this.snapshot;
    if (input.trackingId !== runtime.trackingId) return fail("staleTracking", "記録の状態が変わりました。もう一度操作してください。");
    if (!session || !reminder || reminder.id !== input.reminderId || session.id !== input.sessionId)
      return fail("staleReminder", "この通知は回答済み、または失効しています。");
    this.snapshot.reminder = null;
    const hard = session.elapsedMs >= 60 * this.unit();
    const delay = input.answer === "yes" ? 10 : hard ? 5 : 10;
    this.nextPromptAt = this.now + delay * this.unit();
    this.nextPromptCause = "snoozeLimit";
    this.boundaryEligibleAt = input.answer === "no" && !hard ? this.now + 2 * this.unit() : Infinity;
    this.hardNextAt = hard ? this.nextPromptAt : -Infinity;
    const reportId = input.answer === "yes" ? this.requestReport("yes") : null;
    this.emit();
    return ok({ snapshot: this.snapshot, reportId });
  }

  private requestReport(trigger: "yes" | "away"): Id | null {
    const session = this.snapshot.session;
    if (!session) return null;
    if (session.reportJobId) return session.reportJobId;
    const report = createReport(this.id("report"), session.id, this.now);
    report.trigger = trigger;
    report.history.rangeStart = Math.max(session.startedAt, this.now - 30 * MINUTE);
    report.history.rangeEnd = trigger === "away" ? session.endedAt ?? this.now : this.now;
    report.history.rangeStart = Math.min(report.history.rangeStart, report.history.rangeEnd);
    report.history.segments = report.history.segments
      .filter(segment => segment.endedAt > report.history.rangeStart && segment.startedAt < report.history.rangeEnd)
      .map(segment => ({ ...segment, startedAt: Math.max(segment.startedAt, report.history.rangeStart),
        endedAt: Math.min(segment.endedAt, report.history.rangeEnd) }));
    const job = createJob(report, trigger === "away" ? "scheduled" : "running");
    job.dueAt = this.now + (trigger === "away" ? 5 * this.unit() : 0);
    this.reports.set(report.id, report);
    this.snapshot.jobs.push(job);
    session.reportJobId = job.id;
    return job.id;
  }

  /** センサーの代わりに確定状態を入力する。実機の30秒安定化は模擬しない。 */
  setPresence(value: Presence): void {
    if (this.snapshot.runtime.phase !== "running") return;
    const previous = this.snapshot.presence.value;
    if (value === previous) return;
    this.snapshot.presence = {
      value, reason: value === "present" ? "stableFace" : value === "away" ? "awayConfirmed" :
        value === "uncertain" ? "faceMissing" : "sensorUnavailable",
      faceMissingSince: value === "away" || value === "uncertain" ? this.now : null,
      awayDetectedAt: value === "away" ? this.now : null,
    };
    if (value !== "present") this.snapshot.reminder = null;
    if (value === "away" && this.snapshot.session?.endedAt === null) {
      this.snapshot.session.endedAt = this.now;
      this.snapshot.session.endReason = "away";
      this.requestReport("away");
    } else if (value === "unknown") {
      this.snapshot.session = null;
    } else if (value === "present" && (previous === "away" || previous === "unknown" || !this.snapshot.session)) {
      this.beginSession();
    }
    this.emit();
  }
  detectBoundary(): void {
    if (this.snapshot.presence.value === "present" && this.now >= this.boundaryEligibleAt) {
      this.showReminder("boundary");
      this.emit();
    }
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 86_400_000)
      throw new RangeError("時計は0〜24時間の整数ミリ秒で進めてください。");
    const end = this.now + milliseconds;
    while (this.now < end) {
      this.now = Math.min(end, this.now + 1_000);
      this.tick();
    }
    this.emit();
  }
  private tick(): void {
    const { session, presence, runtime } = this.snapshot;
    if (runtime.phase === "running" && session?.endedAt === null) {
      session.elapsedMs = this.now - session.startedAt;
      if (presence.value === "present") {
        const hard = session.elapsedMs >= 60 * this.unit();
        if (this.snapshot.reminder && hard) this.snapshot.reminder.level = "hard";
        if (!this.snapshot.reminder && ((hard && this.now >= this.hardNextAt) || this.now >= this.nextPromptAt))
          this.showReminder(hard ? "hardLimit" : this.nextPromptCause);
      }
    }
    for (const job of this.snapshot.jobs) {
      if (["scheduled", "queued"].includes(job.status) && this.now >= job.dueAt) job.status = "running";
      if (job.status === "running" && this.now >= job.dueAt + 2_000) this.complete(job);
    }
  }
  private complete(job: ReportJobView): void {
    const report = this.reports.get(job.id);
    if (!report) return;
    const failed = this.generationFailures.delete(job.id);
    report.status = failed ? "failed" : this.snapshot.runtime.effectiveReportMode === "local" ? "local" : "ready";
    report.content = report.status === "ready" ? createReport().content : null;
    report.error = failed ? { code: "networkFailure", message: "開発用の通信失敗です。再試行できます。", retryable: true } : null;
    report.updatedAt = this.now;
    report.attempt = job.attempt;
    job.status = failed ? "failed" : "ready";
    job.completionSeq = ++this.snapshot.completionSeq;
  }

  async updateSettings(input: Omit<UpdateSettingsRequest, "requestId">): Promise<ApiResult<AppSnapshot>> {
    if (this.snapshot.runtime.phase !== "stopped") return fail("invalidState", "設定を変更する前に、作業の記録を停止してください。");
    if (input.expectedSettingsRevision !== this.snapshot.settings.revision) return fail("staleRevision", "設定を読み直してください。");
    if (input.values.reportMode === "ai" && !input.values.provider) return fail("validation", "接続先とモデルを設定してください。");
    const provider = input.values.provider;
    if (provider) {
      try {
        const url = new URL(provider.endpoint);
        if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
          url.username || url.password || !provider.model.trim()) throw new Error();
      } catch { return fail("validation", "接続先 URL とモデルを確認してください。"); }
    }
    const old = this.snapshot.settings;
    const changed = old.provider?.kind !== provider?.kind || old.provider?.endpoint !== provider?.endpoint;
    const hasApiKey = input.keyChange.kind === "replace" ? !!input.keyChange.value.trim() :
      input.keyChange.kind === "remove" || changed ? false : old.hasApiKey;
    // モックはキーの文字列を保存せず、登録有無のみ模擬する。
    this.snapshot.settings = { ...copy(input.values), revision: old.revision + 1, hasApiKey };
    this.emit();
    return ok(this.snapshot);
  }
  async listReports(input: ListReportsRequest): Promise<ApiResult<ReportPage>> {
    const offset = input.cursor === null ? 0 : Number(input.cursor);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20)
      return fail("validation", "一覧の取得範囲が正しくありません。");
    const visibleIds = new Set(this.snapshot.jobs.filter(job => job.status === "ready" || job.status === "failed").map(job => job.id));
    const reports = [...this.reports.values()].filter(report => visibleIds.has(report.id)).sort((a, b) => b.createdAt - a.createdAt);
    const items = reports.slice(offset, offset + input.limit).map(({ id, sessionId, createdAt, updatedAt, status }) =>
      ({ id, sessionId, createdAt, updatedAt, status }));
    return ok({ items, nextCursor: offset + items.length < reports.length ? String(offset + items.length) : null });
  }
  async getReport(reportId: Id): Promise<ApiResult<Report>> {
    const job = this.snapshot.jobs.find(candidate => candidate.id === reportId);
    const report = this.reports.get(reportId);
    return report && (job?.status === "ready" || job?.status === "failed") ? ok(report) : fail("notFound", "カードがありません。");
  }
  async retryReport(input: Omit<RetryReportRequest, "requestId">): Promise<ApiResult<AppSnapshot>> {
    const job = this.snapshot.jobs.find(candidate => candidate.id === input.reportId);
    if (!job || job.status !== "failed" || job.attempt !== input.expectedAttempt) return fail("invalidState", "このレポートは再試行できません。");
    if (this.snapshot.runtime.phase !== "running") return fail("invalidState", "作業の記録を開始してから、もう一度お試しください。");
    job.status = "running"; job.attempt++; job.dueAt = this.now;
    this.emit();
    return ok(this.snapshot);
  }
  async clearData(): Promise<ApiResult<AppSnapshot>> {
    this.stopRuntime();
    this.snapshot.jobs = [];
    this.reports.clear();
    this.generationFailures.clear();
    this.emit();
    return ok(this.snapshot);
  }

  loadScenario(id: ScenarioId): void {
    const previous = this.snapshot;
    this.snapshot = createSnapshot(this.now);
    this.snapshot.runtimeId = previous.runtimeId;
    this.snapshot.revision = previous.revision;
    this.snapshot.completionSeq = previous.completionSeq;
    this.reports.clear(); this.generationFailures.clear();
    this.nextPromptAt = this.boundaryEligibleAt = Infinity;
    this.hardNextAt = -Infinity;
    if (id !== "stopped") {
      this.snapshot.settings = { ...this.snapshot.settings, reportMode: "ai", hasApiKey: true,
        provider: { kind: "openAiCompatible", endpoint: "https://example.invalid/v1/chat/completions", model: "mock-model" } };
      this.snapshot.runtime = { ...this.snapshot.runtime, phase: "running", trackingId: this.id("tracking"),
        camera: "running", activity: "running", effectiveReportMode: "ai",
        consent: { activity: true, history: true, externalReport: true } };
      this.snapshot.presence = { value: "present", reason: "stableFace", faceMissingSince: null, awayDetectedAt: null };
      this.beginSession((id === "hardReminder" ? 60 : id === "advanceNotice" ? 27 : id === "working" ? 29 : 30) * MINUTE);
    }
    if (id === "reminder" || id === "hardReminder") this.showReminder(id === "hardReminder" ? "hardLimit" : "boundary");
    if (id === "snoozed") { this.nextPromptAt = this.now + 10 * MINUTE; this.nextPromptCause = "snoozeLimit"; this.boundaryEligibleAt = this.now + 2 * MINUTE; }
    if (id === "uncertain") this.snapshot.presence = { value: "uncertain", reason: "faceMissing", faceMissingSince: this.now, awayDetectedAt: null };
    if (id === "awayScheduled" || id === "returnedWithPending") {
      if (this.snapshot.session) { this.snapshot.session.endedAt = this.now; this.snapshot.session.endReason = "away"; }
      this.requestReport("away");
      this.snapshot.presence = { value: "away", reason: "awayConfirmed", faceMissingSince: this.now - 30_000, awayDetectedAt: this.now };
      if (id === "returnedWithPending") {
        this.beginSession();
        this.snapshot.presence = { value: "present", reason: "stableFace", faceMissingSince: null, awayDetectedAt: null };
      }
    }
    if (["generating", "reportReady", "reportFailed", "localReport", "emptyReport", "multipleReports"].includes(id)) {
      if (id === "localReport" || id === "emptyReport") this.snapshot.runtime.effectiveReportMode = "local";
      const reportId = this.requestReport("yes");
      const job = this.snapshot.jobs.find(candidate => candidate.id === reportId);
      if (job) {
        if (id === "reportFailed") this.generationFailures.add(job.id);
        if (id === "emptyReport") { const report = this.reports.get(job.id); if (report) report.history.segments = []; }
        if (id !== "generating") this.complete(job);
      }
      if (id === "multipleReports") {
        const report = createReport(this.id("report"), this.id("session"), this.now + 1);
        const extra = createJob(report, "running");
        this.reports.set(report.id, report); this.snapshot.jobs.push(extra); this.complete(extra);
      }
    }
    if (id === "sensorError") {
      this.snapshot.presence = { value: "unknown", reason: "sensorUnavailable", faceMissingSince: null, awayDetectedAt: null };
      this.snapshot.session = null; this.snapshot.runtime.camera = "error";
      this.snapshot.warning = { code: "permissionDenied", message: "開発用：カメラを利用できません。停止後に設定を確認してください。", retryable: true };
    }
    this.emit();
  }
}
