import type { TimingProfile, TimingSettings } from "../contracts/domain.js";

export const timingFields: readonly { key: keyof TimingSettings; label: string; help: string; minutes?: boolean }[] = [
  { key: "firstMs", label: "休憩の目安", minutes: true, help: "連続在席がこの時間に達したら、作業の区切りで休憩を提案します。" },
  { key: "advanceNoticeLeadMs", label: "休憩の何分・何秒前に予告するか", minutes: true, help: "休憩の目安より前に予告します。0で予告しません。" },
  { key: "firstLimitMs", label: "初回通知の上限", minutes: true, help: "区切りがなくても、連続在席がこの時間に達したら通知します。" },
  { key: "cooldownMs", label: "「今は続ける」後の通知抑制", minutes: true, help: "この時間が経ってから、新しい作業の区切りで再通知します。0で抑制しません。" },
  { key: "snoozeMs", label: "「今は続ける」後の再通知の上限", minutes: true, help: "区切りがなくても、この時間後に再通知します。" },
  { key: "hardMs", label: "強調通知の開始時間", minutes: true, help: "連続在席がこの時間に達したら、強く休憩を促します。" },
  { key: "hardRepeatMs", label: "強調通知を断った後の再通知間隔", minutes: true, help: "強調通知で「今は続ける」を選んだ後、この間隔で再通知します。" },
  { key: "yesGraceMs", label: "「レポートを作る」後の猶予", minutes: true, help: "在席を続ける場合、次の通知まで待つ時間です。強調通知の初回到達は優先します。" },
  { key: "absenceMs", label: "離席を確定するまでの時間", help: "顔が見えず、PCも無操作の状態が続いた時間です。" },
  { key: "reportDelayMs", label: "離席確定からレポート作成まで", minutes: true, help: "離席後の待ち時間です。0で直ちに作成を始めます。" },
  { key: "idleMs", label: "作業の区切りとみなす無操作時間", help: "PCの操作が止まったことを区切りとして扱います。" },
  { key: "switchWindowMs", label: "ウィンドウ切り替え後の判定期間", help: "切り替えからこの期間内の無操作を区切りとして扱います。" },
  { key: "switchIdleMs", label: "ウィンドウ切り替え後の無操作時間", help: "切り替え後、区切りとみなすために必要な無操作時間です。" },
];

export const timingUnitMs = (profile: TimingProfile, field: typeof timingFields[number]) =>
  profile === "normal" && field.minutes ? 60_000 : 1_000;

export function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  const rest = seconds % 60;
  return `${hours ? `${hours}時間` : ""}${minutes ? `${minutes}分` : ""}${rest || !seconds ? `${rest}秒` : ""}`;
}
