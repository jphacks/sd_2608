import type { ApiError, AppSnapshot, ApiResult, Id, Report, FaceInput } from "../contracts/domain.js";
import type { StartRuntimeRequest, RespondReminderRequest, RespondReminderResult, UpdateSettingsRequest, ListReportsRequest, ReportPage, RetryReportRequest, FaceReceipt } from "../contracts/api.js";
import type { WindowAdapter } from "./WindowAdapter.js";

export interface AppGateway {
  readonly window?: WindowAdapter;
  connect(onSnapshot: (state: AppSnapshot) => void, onConnectionError?: (error: ApiError | null) => void): Promise<AppSnapshot>;
  start(input: Omit<StartRuntimeRequest, "requestId">): Promise<ApiResult<AppSnapshot>>;
  stop(trackingId: Id): Promise<ApiResult<AppSnapshot>>;
  respond(input: Omit<RespondReminderRequest, "requestId">):
    Promise<ApiResult<RespondReminderResult>>;
  updateSettings(input: Omit<UpdateSettingsRequest, "requestId">):
    Promise<ApiResult<AppSnapshot>>;
  listReports(input: ListReportsRequest): Promise<ApiResult<ReportPage>>;
  getReport(reportId: Id): Promise<ApiResult<Report>>;
  retryReport(input: Omit<RetryReportRequest, "requestId">):
    Promise<ApiResult<AppSnapshot>>;
  clearData(): Promise<ApiResult<AppSnapshot>>;
  dispose(): Promise<void>;
}
export interface FaceInputPort {
  submit(input: FaceInput): Promise<ApiResult<FaceReceipt>>;
}

export class GatewayConnectionError extends Error {
  constructor(readonly detail: ApiError) { super(detail.message); }
}
