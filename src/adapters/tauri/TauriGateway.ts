import { SNAPSHOT_EVENT } from "../../contracts/index.js";
import type { ApiError, ApiResult, AppSnapshot, FaceInput, Id } from "../../contracts/domain.js";
import type { ListReportsRequest, RespondReminderRequest, RetryReportRequest, StartRuntimeRequest, UpdateSettingsRequest } from "../../contracts/api.js";
import type { IpcCommands } from "../../contracts/ipc.js";
import { GatewayConnectionError } from "../../ports/AppGateway.js";
import type { AppGateway, FaceInputPort } from "../../ports/AppGateway.js";
import type { FaceCapture, FaceCaptures } from "../../ports/FaceCapture.js";
import { DecodeError, decodeCommandResult, snapshotDecoder } from "./decode.js";
import { browserEnvironment } from "./transport.js";
import type { GatewayEnvironment, IpcTransport, Unsubscribe } from "./transport.js";
import type { WindowAdapter } from "../../ports/WindowAdapter.js";

type SnapshotMutation = "runtime_start" | "runtime_stop" | "settings_update" | "report_retry" | "data_clear";
type Connection = {
  observer: (snapshot: AppSnapshot) => void;
  health: (error: ApiError | null) => void;
  snapshot: AppSnapshot | null;
  buffered: AppSnapshot[];
  retiredRuntimes: Set<string>;
  cleanups: Unsubscribe[];
  closed: boolean;
  reading: Promise<void> | null;
  refreshAgain: boolean;
};
const error = (code: ApiError["code"], message: string, retryable = true): ApiError => ({ code, message, retryable });
const cancelled = (): ApiError => error("cancelled", "接続が更新されたため、古い処理の結果を破棄しました。", false);
const failure = <T>(detail: ApiError): ApiResult<T> => ({ ok: false, error: detail });
const normalize = (cause: unknown): ApiError => cause instanceof DecodeError
  ? error("invalidResponse", cause.message, false)
  : cause instanceof GatewayConnectionError ? cause.detail
  : error("internal", "アプリとの通信に失敗しました。再接続してください。");

export class TauriGateway implements AppGateway, FaceInputPort {
  private connection: Connection | null = null;
  private capture: { connection: Connection; trackingId: Id; controller: FaceCapture; source: "camera" | "manual" } | null = null;
  private captureEpoch = 0;
  private starting = false;
  constructor(private readonly transport: IpcTransport, private readonly environment: GatewayEnvironment = browserEnvironment,
    private readonly captures?: FaceCaptures, readonly window?: WindowAdapter) {}
  private releaseCapture(): void {
    ++this.captureEpoch;
    const capture = this.capture; this.capture = null;
    try { capture?.controller.stop(); } catch { /* 取得側の解放失敗でも Rust への停止を続ける。 */ }
  }
  private current(connection: Connection): boolean { return this.connection === connection && !connection.closed; }
  private close(connection: Connection): void {
    if (this.connection === connection || this.capture?.connection === connection) this.releaseCapture();
    connection.closed = true;
    for (const cleanup of connection.cleanups.splice(0)) { try { cleanup(); } catch { /* 解放済みでも残りを解放する。 */ } }
    connection.buffered = [];
  }
  async connect(observer: (snapshot: AppSnapshot) => void, health: (error: ApiError | null) => void = () => {}): Promise<AppSnapshot> {
    if (this.connection) {
      const trackingId = this.connection.snapshot?.runtime.trackingId;
      this.close(this.connection);
      if (trackingId) void this.invoke("runtime_stop", { requestId: this.environment.requestId(), trackingId });
    }
    const connection: Connection = { observer, health, snapshot: null, buffered: [], retiredRuntimes: new Set(),
      cleanups: [], closed: false, reading: null, refreshAgain: false };
    this.connection = connection;
    try {
      const unlisten = await this.transport.listen(SNAPSHOT_EVENT, payload => {
        if (!this.current(connection)) return;
        try {
          const snapshot = snapshotDecoder(payload);
          if (!connection.snapshot) connection.buffered.push(snapshot);
          else this.adopt(connection, snapshot, "event");
        } catch (cause) { connection.health(normalize(cause)); if (connection.snapshot) void this.refresh(connection); }
      });
      if (!this.current(connection)) { unlisten(); throw new GatewayConnectionError(cancelled()); }
      connection.cleanups.push(unlisten);
      const initial = await this.invoke("app_get_snapshot");
      if (!this.current(connection)) throw new GatewayConnectionError(cancelled());
      if (!initial.ok) throw new GatewayConnectionError(initial.error);
      connection.snapshot = initial.data;
      const buffered = connection.buffered.splice(0);
      for (const snapshot of buffered) this.adopt(connection, snapshot, "event");
      connection.cleanups.push(this.environment.every(5_000, () => { void this.refresh(connection); }));
      connection.cleanups.push(this.environment.onResume(() => { void this.refresh(connection); }));
      if (this.environment.onUnload) connection.cleanups.push(this.environment.onUnload(() => { void this.dispose(); }));
      connection.health(null);
      return structuredClone(connection.snapshot);
    } catch (cause) {
      this.close(connection);
      if (this.connection === connection) this.connection = null;
      throw new GatewayConnectionError(normalize(cause));
    }
  }
  private adopt(connection: Connection, snapshot: AppSnapshot, source: "read" | "event"): void {
    if (!this.current(connection)) return;
    const previous = connection.snapshot;
    if (connection.retiredRuntimes.has(snapshot.runtimeId)) return;
    if (previous && previous.runtimeId !== snapshot.runtimeId) {
      // 未知の runtime のイベントだけでは正本を切り替えず、IPC で確認する。
      if (source === "event") { void this.refresh(connection); return; }
      connection.retiredRuntimes.add(previous.runtimeId);
    } else if (previous && snapshot.revision <= previous.revision) return;
    connection.snapshot = snapshot;
    if (this.capture?.connection === connection && (snapshot.runtimeId !== previous?.runtimeId
      || snapshot.runtime.trackingId !== this.capture.trackingId || snapshot.runtime.phase !== "running")) this.releaseCapture();
    connection.observer(structuredClone(snapshot));
  }
  private refresh(connection: Connection): Promise<void> {
    if (!this.current(connection)) return Promise.resolve();
    if (connection.reading) { connection.refreshAgain = true; return connection.reading; }
    const reading = Promise.resolve().then(async () => {
      do {
        connection.refreshAgain = false;
        const result = await this.invoke("app_get_snapshot");
        if (!this.current(connection)) return;
        if (result.ok) { this.adopt(connection, result.data, "read"); connection.health(null); }
        else connection.health(result.error);
      } while (connection.refreshAgain && this.current(connection));
    });
    connection.reading = reading;
    void reading.finally(() => { if (connection.reading === reading) connection.reading = null; });
    return reading;
  }
  private async invoke<K extends keyof IpcCommands>(command: K, request?: IpcCommands[K]["request"]): Promise<ApiResult<IpcCommands[K]["response"]>> {
    try {
      const raw = await this.transport.invoke(command, request === undefined ? undefined : { request });
      return decodeCommandResult(command, raw);
    } catch (cause) { return failure(normalize(cause)); }
  }
  private async execute<K extends keyof IpcCommands>(command: K, request: IpcCommands[K]["request"]): Promise<ApiResult<IpcCommands[K]["response"]>> {
    const connection = this.connection;
    if (!connection?.snapshot || !this.current(connection)) return failure(error("invalidState", "アプリへ接続してから操作してください。", false));
    const runtimeId = connection.snapshot.runtimeId;
    const result = await this.invoke(command, request);
    if (!this.current(connection) || connection.snapshot?.runtimeId !== runtimeId) {
      // 開始受付の直後に解除された場合も、取り残した監視をその trackingId で停止する。
      if (command === "runtime_start" && result.ok) {
        const started = snapshotDecoder(result.data);
        if (started.runtime.trackingId) await this.invoke("runtime_stop", { requestId: this.environment.requestId(), trackingId: started.runtime.trackingId });
      }
      return failure(cancelled());
    }
    return result;
  }
  private async mutate<K extends SnapshotMutation>(command: K, request: IpcCommands[K]["request"]): Promise<ApiResult<AppSnapshot>> {
    const connection = this.connection;
    const result = await this.execute(command, request);
    if (result.ok && connection && this.current(connection)) this.adopt(connection, result.data, "read");
    return result;
  }
  start(input: Omit<StartRuntimeRequest, "requestId">) {
    return this.startCapture(input, "camera");
  }
  startManual(input: Omit<StartRuntimeRequest, "requestId">) {
    if (input.profile !== "demo" || !this.captures?.manual) return Promise.resolve(failure<AppSnapshot>(error("permissionDenied", "手動入力はデモ用の明示的な開始だけで利用できます。", false)));
    return this.startCapture(input, "manual");
  }
  setManualFaceDetected(value: boolean): void {
    if (this.capture?.source === "manual") this.captures?.manual?.setFaceDetected(value);
  }
  private async startCapture(input: Omit<StartRuntimeRequest, "requestId">, source: "camera" | "manual"): Promise<ApiResult<AppSnapshot>> {
    if (this.starting) return failure(error("invalidState", "開始処理中です。", false));
    this.starting = true;
    const connection = this.connection;
    const epoch = this.captureEpoch;
    try {
      const result = await this.mutate("runtime_start", { ...input, requestId: this.environment.requestId() });
      if (!result.ok || !connection) return result;
      const trackingId = result.data.runtime.trackingId;
      if (!trackingId || !this.current(connection) || epoch !== this.captureEpoch
        || connection.snapshot?.runtime.trackingId !== trackingId || connection.snapshot.runtime.phase !== "running") {
        if (trackingId) await this.invoke("runtime_stop", { requestId: this.environment.requestId(), trackingId });
        return failure(cancelled());
      }
      const controller = this.captures?.[source];
      if (controller) {
        this.capture = { connection, trackingId, controller, source };
        try {
          controller.start(trackingId, async face => {
            if (this.capture?.controller !== controller || this.capture.trackingId !== trackingId || !this.current(connection)) return false;
            return (await this.submit(face)).ok;
          });
        } catch {
          this.releaseCapture();
          await this.invoke("runtime_stop", { requestId: this.environment.requestId(), trackingId });
          return failure(error("internal", "カメラを開始できませんでした。停止状態を確認して再開してください。", false));
        }
      }
      return result;
    } finally { this.starting = false; }
  }
  stop(trackingId: Id) {
    if (this.capture?.trackingId === trackingId || this.connection?.snapshot?.runtime.trackingId === trackingId) this.releaseCapture();
    return this.mutate("runtime_stop", { trackingId, requestId: this.environment.requestId() });
  }
  updateSettings(input: Omit<UpdateSettingsRequest, "requestId">) { return this.mutate("settings_update", { ...input, requestId: this.environment.requestId() }); }
  retryReport(input: Omit<RetryReportRequest, "requestId">) { return this.mutate("report_retry", { ...input, requestId: this.environment.requestId() }); }
  clearData() { this.releaseCapture(); return this.mutate("data_clear", { requestId: this.environment.requestId() }); }
  listReports(input: ListReportsRequest) { return this.execute("report_list", input); }
  getReport(reportId: Id) { return this.execute("report_get", { reportId }); }
  submit(input: FaceInput) { return this.execute("face_submit", input); }
  async respond(input: Omit<RespondReminderRequest, "requestId">) {
    const connection = this.connection;
    const result = await this.execute("reminder_respond", { ...input, requestId: this.environment.requestId() });
    if (result.ok && connection && this.current(connection)) this.adopt(connection, result.data.snapshot, "read");
    return result;
  }
  async dispose(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    const trackingId = connection.snapshot?.runtime.trackingId;
    this.close(connection);
    this.connection = null;
    if (trackingId) await this.invoke("runtime_stop", { requestId: this.environment.requestId(), trackingId });
  }
}
