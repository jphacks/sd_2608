import type { Report } from "../contracts/domain.js";

export const reportStatusLabels: Record<Report["status"], string> = {
  ready: "AI 要約あり",
  failed: "AI 要約の作成に失敗",
  local: "端末内の記録",
};
