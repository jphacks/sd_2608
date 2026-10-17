import type { AppSnapshot, FaceInput, Id, Report } from "./domain.js";
import type {
  FaceReceipt, ListReportsRequest, ReportPage, RespondReminderRequest,
  RespondReminderResult, RetryReportRequest, StartRuntimeRequest,
  StopRuntimeRequest, UpdateSettingsRequest,
} from "./api.js";

/** Rust 側を接続するときもコマンド名・引数・応答をこの表に合わせる。 */
export interface IpcCommands {
  app_get_snapshot: { request: undefined; response: AppSnapshot };
  runtime_start: { request: StartRuntimeRequest; response: AppSnapshot };
  runtime_stop: { request: StopRuntimeRequest; response: AppSnapshot };
  face_submit: { request: FaceInput; response: FaceReceipt };
  reminder_respond: { request: RespondReminderRequest; response: RespondReminderResult };
  settings_update: { request: UpdateSettingsRequest; response: AppSnapshot };
  report_list: { request: ListReportsRequest; response: ReportPage };
  report_get: { request: { reportId: Id }; response: Report };
  report_retry: { request: RetryReportRequest; response: AppSnapshot };
  data_clear: { request: { requestId: Id }; response: AppSnapshot };
}
