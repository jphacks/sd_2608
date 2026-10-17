import type { Id, TimingProfile, AppSnapshot, SettingsInput, KeyChange, Report } from "./domain.js";

export type StartRuntimeRequest = {
  requestId: Id;
  profile: TimingProfile;
  expectedSettingsRevision: number;
  reportMode: "local" | "ai";
  consent: { activity: boolean; history: boolean; externalReport: boolean };
};
export type StopRuntimeRequest = { requestId: Id; trackingId: Id };
export type FaceReceipt = { acceptedSequence: number; snapshotRevision: number };
export type RespondReminderRequest = {
  requestId: Id;
  trackingId: Id;
  sessionId: Id;
  reminderId: Id;
  answer: "yes" | "no";
};
export type RespondReminderResult = {
  snapshot: AppSnapshot;
  reportId: Id | null; // No は null、Yes は受付済みジョブの ID
};
export type UpdateSettingsRequest = {
  requestId: Id;
  expectedSettingsRevision: number;
  values: SettingsInput;
  keyChange: KeyChange;
};
export type ListReportsRequest = { cursor: string | null; limit: number };
export type ReportListItem = Pick<Report,
  "id" | "sessionId" | "createdAt" | "updatedAt" | "status">;
export type ReportPage = { items: ReportListItem[]; nextCursor: string | null };
export type RetryReportRequest = {
  requestId: Id;
  reportId: Id;
  expectedAttempt: number;
};
