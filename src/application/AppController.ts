import type { AppGateway } from "../ports/AppGateway.js";
import type { NotificationAudio } from "../ports/NotificationAudio.js";
import { GatewayConnectionError } from "../ports/AppGateway.js";
import type { ApiError, ApiResult, AppSnapshot, Id } from "../contracts/domain.js";
import type { AppViewActions, AppViewModel, UiOperation } from "../contracts/ui.js";
import type { ReportListItem } from "../contracts/api.js";
import { finishMotion, initialMotion, moveTo } from "../pochi/animation.js";
import { formatDuration } from "../presentation/timingSettings.js";

const connectionError = (): ApiError => ({ code: "internal", message: "接続または取得に失敗しました。再接続してください。", retryable: true });

/** React・Tauri に依存しない接続処理。画面側で時刻判定・ジョブ判定を再実装しない。 */
export class AppController {
  private state: AppViewModel = {
    connection: "connecting", snapshot: null,
    pet: { pose: "sit", animation: "launch", playbackToken: "launch", greeting: null, statusText: "接続中" },
    motion: initialMotion(),
    bubble: null, advanceNotice: null, report: { phase: "closed" }, reportList: [], reportListLoading: false,
    queuedReportCount: 0, pending: null, error: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private seenCompletion = 0;
  private reportQueue: Id[] = [];
  private reportRead = 0;
  private listRead = 0;
  private retiredRuntimes = new Set<Id>();
  private awaitingReturn = false;
  private closing = false;
  private mutation = 0;
  private dismissedAdvanceNotice: string | null = null;
  private soundedNotifications = new Set<string>();
  private settingsOpen = false;

  constructor(private readonly gateway: AppGateway, private readonly audio?: NotificationAudio) {}
  getState = (): AppViewModel => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<AppViewModel>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  async connect(): Promise<void> {
    const epoch = ++this.epoch;
    this.retiredRuntimes = new Set();
    const buffered: AppSnapshot[] = [];
    let initializing = true;
    this.publish({ connection: "connecting", pending: null, error: null, advanceNotice: null });
    try {
      const initial = await this.gateway.connect(snapshot => {
        if (epoch !== this.epoch) return;
        if (initializing) buffered.push(snapshot);
        else this.accept(snapshot);
      }, error => {
        if (epoch !== this.epoch) return;
        if (error) this.publish({ connection: "error", error, advanceNotice: null });
        else if (!initializing && this.state.connection === "error") this.publish({ connection: "connected", error: null });
      });
      if (epoch !== this.epoch) return;
      // connect が返した正本より前の runtime を、初期バッファから復活させない。
      let lastInitialRuntime = -1;
      buffered.forEach((snapshot, index) => { if (snapshot.runtimeId === initial.runtimeId) lastInitialRuntime = index; });
      for (const snapshot of buffered.slice(0, Math.max(0, lastInitialRuntime))) {
        if (snapshot.runtimeId !== initial.runtimeId) this.retiredRuntimes.add(snapshot.runtimeId);
      }
      this.resetRuntime(initial);
      this.accept(initial, true);
      initializing = false;
      // revision は runtime 内だけで比較できる。別 runtime を番号で並べ替えない。
      for (const snapshot of buffered) this.accept(snapshot);
      this.publish({ connection: "connected" });
      await this.refreshReports();
    } catch (error) {
      if (epoch === this.epoch) this.publish({ connection: "error", advanceNotice: null, error: error instanceof GatewayConnectionError ? error.detail : connectionError() });
    }
  }
  async dispose(): Promise<void> {
    this.epoch++; this.reportRead++; this.listRead++;
    this.audio?.stop();
    this.publish({ advanceNotice: null });
    await this.gateway.dispose();
  }
  private resetRuntime(snapshot: AppSnapshot): void {
    this.audio?.stop();
    this.soundedNotifications.clear();
    this.mutation++;
    this.awaitingReturn = false;
    this.seenCompletion = snapshot.completionSeq;
    this.reportQueue = [];
    this.reportRead++; this.listRead++;
    this.publish({ snapshot: null, pending: null, advanceNotice: null, motion: { ...initialMotion(), token: this.state.motion.token + 1 },
      report: { phase: "closed" }, reportList: [], reportListLoading: false, queuedReportCount: 0 });
  }
  private accept(snapshot: AppSnapshot, initial = false): void {
    if (this.retiredRuntimes.has(snapshot.runtimeId)) return;
    const previous = this.state.snapshot;
    if (previous && previous.runtimeId !== snapshot.runtimeId) {
      this.retiredRuntimes.add(previous.runtimeId);
      this.resetRuntime(snapshot);
    }
    else if (!initial && previous && snapshot.revision <= previous.revision) return;
    const returned = this.awaitingReturn && snapshot.presence.value === "present" && snapshot.runtime.phase === "running";
    if (snapshot.runtime.phase !== "running" || snapshot.presence.value === "unknown") this.awaitingReturn = false;
    else if (snapshot.presence.value === "away") this.awaitingReturn = true;
    else if (snapshot.presence.value === "present") this.awaitingReturn = false;
    const resting = (snapshot.runtime.phase === "stopped" || snapshot.presence.value !== "present")
      && this.state.report.phase === "closed" && !this.settingsOpen;
    const reminder = snapshot.reminder;
    const notice = snapshot.advanceNotice;
    const noticeKey = this.advanceNoticeKey(snapshot);
    const previousNotice = previous?.runtimeId === snapshot.runtimeId
      && previous?.runtime.trackingId === snapshot.runtime.trackingId ? this.state.advanceNotice : null;
    const noticeSessionId = notice?.sessionId ?? previousNotice?.sessionId;
    const showNotice = noticeSessionId && noticeKey !== this.dismissedAdvanceNotice
      && snapshot.runtime.phase === "running" && snapshot.presence.value === "present"
      && snapshot.session?.endedAt === null && snapshot.session.id === noticeSessionId && !reminder;
    const currentReportId = this.currentReportId();
    const completions = snapshot.jobs.filter(job => job.completionSeq !== null && job.completionSeq > this.seenCompletion)
      .sort((a, b) => a.completionSeq! - b.completionSeq!);
    this.seenCompletion = Math.max(this.seenCompletion, snapshot.completionSeq);
    // 毎秒の snapshot では再生し直さず、業務状態の変化だけを演出へ渡す。
    const newReminder = reminder && reminder.id !== previous?.reminder?.id;
    const poseChanged = resting !== (this.state.motion.after === "rest");
    const motion = newReminder || returned || poseChanged
      ? moveTo(this.state.motion, resting ? "rest" : "idle", newReminder ? "reminder" : returned ? "welcome" : undefined)
      : this.state.motion;
    this.publish({
      snapshot,
      motion,
      advanceNotice: showNotice ? { sessionId: noticeSessionId,
        text: notice ? `あと${formatDuration(notice.remainingMs)}ほどで休憩の目安だよ。区切りのよいところで、ひと息つく準備をしよう。`
          : "そろそろ休憩の時間だよ。区切りのよいところで、ひと息つこう。" } : null,
      pet: {
        pose: resting ? "lie" : "sit",
        animation: reminder ? "recordReminder" : returned ? "welcome" : !previous && snapshot.runtime.phase === "stopped" ? "launch" : resting ? "idleRest" : null,
        playbackToken: reminder?.id ?? (returned ? `return-${snapshot.session?.id}` : `${snapshot.runtimeId}-${resting ? "rest" : "sit"}`),
        greeting: returned ? "おかえりなさい！" : null,
        statusText: snapshot.runtime.phase === "stopped" ? "記録はお休み中" :
          snapshot.presence.value === "present" ? "作業を記録中" :
          snapshot.presence.value === "away" ? "ゆっくり休憩してね" : "席にいるか確認できません",
      },
      bubble: reminder ? {
        reminderId: reminder.id, emphasis: reminder.level,
        text: reminder.level === "hard" ? "長く座り続けているかも。少し立って休憩しない？" : "しばらく座りっぱなしかも。少し立って休憩しない？",
        yesLabel: "レポートを作る", noLabel: "今は続ける", disabled: this.state.pending !== null,
      } : null,
    });
    for (const job of completions) {
      if (job.id === currentReportId) void this.openReport(job.id);
      else if (!this.reportQueue.includes(job.id)) this.reportQueue.push(job.id);
    }
    this.publish({ queuedReportCount: this.reportQueue.length });
    const notificationKeys = [
      ...(showNotice ? [`advance:${noticeKey}`] : []),
      ...(reminder ? [`reminder:${reminder.id}`] : []),
      ...completions.map(job => `completion:${job.completionSeq}`),
    ];
    const newNotification = notificationKeys.some(key => !this.soundedNotifications.has(key));
    for (const key of notificationKeys) this.soundedNotifications.add(key);
    if (previous?.settings.notificationSound !== snapshot.settings.notificationSound) this.audio?.stop();
    // 初回取得・再接続・バックエンド再起動では、既存の通知を鳴らし直さない。
    if (previous?.runtimeId === snapshot.runtimeId && newNotification)
      this.audio?.play(snapshot.settings.notificationSound);
    this.pumpReportQueue();
    if (completions.length) void this.refreshReports();
  }
  private currentReportId(): Id | null {
    const report = this.state.report;
    return report.phase === "closed" ? null : report.phase === "ready" ? report.report.id : report.reportId;
  }
  private advanceNoticeKey(snapshot: AppSnapshot): string {
    return JSON.stringify([snapshot.runtimeId, snapshot.runtime.trackingId, snapshot.session?.id]);
  }
  private pumpReportQueue(): void {
    if (this.state.report.phase !== "closed") return;
    const next = this.reportQueue.shift();
    this.publish({ queuedReportCount: this.reportQueue.length });
    if (next) void this.openReport(next);
  }
  private async mutate<T>(operation: UiOperation, perform: () => Promise<ApiResult<T>>, snapshotOf: (value: T) => AppSnapshot): Promise<boolean> {
    if (this.state.pending || this.state.connection !== "connected") return false;
    const epoch = this.epoch;
    const mutation = ++this.mutation;
    const runtimeId = this.state.snapshot?.runtimeId;
    this.publish({ pending: operation, error: null,
      bubble: this.state.bubble ? { ...this.state.bubble, disabled: true } : null });
    try {
      const result = await perform();
      if (epoch !== this.epoch || mutation !== this.mutation || this.state.snapshot?.runtimeId !== runtimeId) return false;
      if (!result.ok) { this.publish({ error: result.error }); return false; }
      this.accept(snapshotOf(result.data));
      return true;
    } catch {
      if (epoch === this.epoch && mutation === this.mutation) this.publish({ error: connectionError() });
      return false;
    } finally {
      if (epoch === this.epoch && mutation === this.mutation) this.publish({ pending: null, bubble: this.state.bubble ? { ...this.state.bubble, disabled: false } : null });
    }
  }
  private async refreshReports(): Promise<boolean> {
    const epoch = this.epoch; const read = ++this.listRead;
    this.publish({ reportListLoading: true });
    try {
      const items: ReportListItem[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const result = await this.gateway.listReports({ cursor, limit: 20 });
        if (epoch !== this.epoch || read !== this.listRead) return false;
        if (!result.ok) { this.publish({ error: result.error }); return false; }
        items.push(...result.data.items);
        cursor = result.data.nextCursor;
        if (cursor !== null) {
          if (cursors.has(cursor)) throw new Error("Repeated report cursor");
          cursors.add(cursor);
        }
      } while (cursor !== null);
      this.publish({ reportList: items });
      return true;
    } catch {
      if (epoch === this.epoch && read === this.listRead) this.publish({ error: connectionError() });
      return false;
    }
    finally { if (epoch === this.epoch && read === this.listRead) this.publish({ reportListLoading: false }); }
  }
  private async openReport(reportId: Id): Promise<void> {
    const epoch = this.epoch; const read = ++this.reportRead;
    this.reportQueue = this.reportQueue.filter(id => id !== reportId);
    this.publish({ report: { phase: "loading", reportId }, queuedReportCount: this.reportQueue.length,
      motion: moveTo(this.state.motion, "idle", "record") });
    try {
      const result = await this.gateway.getReport(reportId);
      if (epoch !== this.epoch || read !== this.reportRead) return;
      this.publish({ report: result.ok ? { phase: "ready", report: result.data } : { phase: "error", reportId, error: result.error } });
    } catch {
      if (epoch === this.epoch && read === this.reportRead) this.publish({ report: { phase: "error", reportId, error: connectionError() } });
    }
  }
  readonly actions: AppViewActions = {
    completeAnimation: token => { this.publish({ motion: finishMotion(this.state.motion, token) }); },
    setSettingsOpen: open => {
      if (this.settingsOpen === open) return;
      this.settingsOpen = open;
      const snapshot = this.state.snapshot;
      const resting = !open && this.state.report.phase === "closed"
        && (!snapshot || snapshot.runtime.phase === "stopped" || snapshot.presence.value !== "present");
      this.publish({ motion: moveTo(this.state.motion, resting ? "rest" : "idle") });
    },
    turn: () => { this.publish({ motion: moveTo(this.state.motion, "idle", "turn_sit") }); },
    reconnect: () => this.connect(),
    moveWindow: () => this.windowOperation(() => this.gateway.window?.drag()),
    placeWindow: () => this.windowOperation(() => this.gateway.window?.place()),
    pinWindow: value => this.windowOperation(() => this.gateway.window?.pin(value)),
    closeApp: async () => {
      if (this.closing || this.state.pending) return;
      this.closing = true;
      try {
        // 停止失敗時はウィンドウを残し、再停止できるようにする。
        const trackingId = this.state.snapshot?.runtime.trackingId;
        if (trackingId && !await this.mutate("stop", () => this.gateway.stop(trackingId), value => value)) return;
        await this.windowOperation(() => this.gateway.window?.close());
      } finally { this.closing = false; }
    },
    start: async input => { await this.mutate("start", () => this.gateway.start(input), value => value); },
    stop: async () => {
      const trackingId = this.state.snapshot?.runtime.trackingId;
      if (trackingId) await this.mutate("stop", () => this.gateway.stop(trackingId), value => value);
    },
    answer: async answer => {
      const snapshot = this.state.snapshot;
      if (!snapshot?.reminder || !snapshot.runtime.trackingId) return;
      const { reminder, runtime } = snapshot;
      const result = await this.mutate("answer", () => this.gateway.respond({
        trackingId: runtime.trackingId!, sessionId: reminder.sessionId, reminderId: reminder.id, answer,
      }), value => value.snapshot);
      if (result && answer === "yes" && this.state.snapshot?.session?.reportJobId) {
        const id = this.state.snapshot.session.reportJobId;
        const finished = this.state.snapshot?.jobs.find(job => job.id === id && (job.status === "ready" || job.status === "failed"));
        if (finished && this.currentReportId() !== id && !this.reportQueue.includes(id)) {
          this.reportQueue.push(id);
          this.publish({ queuedReportCount: this.reportQueue.length });
          this.pumpReportQueue();
        }
      }
    },
    saveSettings: async input => { await this.mutate("settings", () => this.gateway.updateSettings(input), value => value); },
    openReport: id => this.openReport(id),
    openLatestReport: async () => {
      if (!await this.refreshReports()) return;
      const latest = this.state.reportList[0];
      if (latest) await this.openReport(latest.id);
    },
    closeReport: () => {
      this.reportRead++;
      const snapshot = this.state.snapshot;
      const resting = !this.settingsOpen && (!snapshot || snapshot.runtime.phase === "stopped" || snapshot.presence.value !== "present");
      this.publish({ report: { phase: "closed" }, motion: moveTo(this.state.motion, resting ? "rest" : "idle") });
      this.pumpReportQueue();
    },
    retryReport: async () => {
      const panel = this.state.report;
      if (panel.phase !== "ready" || panel.report.status !== "failed") return;
      if (await this.mutate("retry", () => this.gateway.retryReport({ reportId: panel.report.id, expectedAttempt: panel.report.attempt }), value => value)) {
        const finished = this.state.snapshot?.jobs.some(job => job.id === panel.report.id && job.attempt > panel.report.attempt && (job.status === "ready" || job.status === "failed"));
        if (!finished) this.publish({ report: { phase: "loading", reportId: panel.report.id } });
      }
    },
    refreshReports: async () => { await this.refreshReports(); },
    clearData: async () => {
      if (this.state.pending || this.state.connection !== "connected") return;
      // 削除要求より前の非同期読込が、削除後に UI を復活させない。
      this.reportRead++; this.listRead++; this.reportQueue = [];
      if (await this.mutate("clear", () => this.gateway.clearData(), value => value))
        this.publish({ report: { phase: "closed" }, reportList: [], reportListLoading: false, queuedReportCount: 0,
          motion: moveTo(this.state.motion, this.settingsOpen ? "idle" : "rest") });
    },
    dismissError: () => { this.publish({ error: null }); },
    dismissAdvanceNotice: () => {
      if (!this.state.advanceNotice || !this.state.snapshot) return;
      this.dismissedAdvanceNotice = this.advanceNoticeKey(this.state.snapshot);
      this.publish({ advanceNotice: null });
    },
  };
  private async windowOperation(operation: () => Promise<void> | undefined): Promise<void> {
    try { await operation(); }
    catch { this.publish({ error: { code: "internal", message: "ウィンドウを操作できませんでした。もう一度お試しください。", retryable: true } }); }
  }
}
