import type { ApiError, AppSnapshot, Id, Report, SettingsView } from "./domain.js";
import type { ReportListItem, StartRuntimeRequest, UpdateSettingsRequest } from "./api.js";
import type { BubbleViewModel, PetManifest, PetViewModel } from "./presentation.js";

export type StartInput = Omit<StartRuntimeRequest, "requestId">;
export type SaveSettingsInput = Omit<UpdateSettingsRequest, "requestId">;
export type UiOperation = "start" | "stop" | "answer" | "settings" | "retry" | "clear";
export type ReportPanelState =
  | { phase: "closed" }
  | { phase: "loading"; reportId: Id }
  | { phase: "ready"; report: Report }
  | { phase: "error"; reportId: Id; error: ApiError };

export type AppViewModel = {
  connection: "connecting" | "connected" | "error";
  snapshot: AppSnapshot | null;
  pet: PetViewModel;
  bubble: BubbleViewModel | null;
  report: ReportPanelState;
  reportList: ReportListItem[];
  reportListLoading: boolean;
  queuedReportCount: number;
  pending: UiOperation | null;
  error: ApiError | null;
};
export interface AppViewActions {
  start(input: StartInput): Promise<void>;
  stop(): Promise<void>;
  answer(answer: "yes" | "no"): Promise<void>;
  saveSettings(input: SaveSettingsInput): Promise<void>;
  openReport(reportId: Id): Promise<void>;
  openLatestReport(): Promise<void>;
  closeReport(): void;
  retryReport(): Promise<void>;
  refreshReports(): Promise<void>;
  clearData(): Promise<void>;
  dismissError(): void;
}
/** 表示担当の入口。この Props を維持すれば内部のコンポーネント構成は自由。 */
export type AppViewProps = { state: AppViewModel; actions: AppViewActions; petManifest: PetManifest };
export type PetStageProps = {
  pet: PetViewModel; manifest: PetManifest; reducedMotion: boolean; onClick(): void;
};
export type MessageBubbleProps = { bubble: BubbleViewModel; onAnswer(answer: "yes" | "no"): void };
export type ReportPanelProps = {
  state: ReportPanelState; queuedCount: number; busy: boolean;
  onClose(): void; onRetry(): void;
};
export type SettingsPanelProps = {
  settings: SettingsView; disabled: boolean; onSave(input: SaveSettingsInput): Promise<void>;
};
