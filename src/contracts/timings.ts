import type { TimingProfiles, TimingSettings } from "./domain.js";

export const timingKeys = ["absenceMs","reportDelayMs","firstMs","advanceNoticeLeadMs","firstLimitMs","snoozeMs","cooldownMs","hardMs","hardRepeatMs","yesGraceMs","idleMs","switchWindowMs","switchIdleMs"] as const;
export const zeroAllowedTimings: readonly (keyof TimingSettings)[] = ["reportDelayMs", "advanceNoticeLeadMs", "cooldownMs", "yesGraceMs"];
export const MAX_TIMING_MS = 86_400_000;

/** 呼び出すたびに独立した設定を返す。Rust Timings::NORMAL / DEMO と同じ初期値。 */
export function createTimingProfiles(): TimingProfiles {
  return {
    normal: {
      absenceMs: 30000,
      reportDelayMs: 300000,
      firstMs: 1800000,
      advanceNoticeLeadMs: 180000,
      firstLimitMs: 2100000,
      snoozeMs: 600000,
      cooldownMs: 120000,
      hardMs: 3600000,
      hardRepeatMs: 300000,
      yesGraceMs: 600000,
      idleMs: 5000,
      switchWindowMs: 10000,
      switchIdleMs: 2000,
    },
    demo: {
      absenceMs: 5000,
      reportDelayMs: 5000,
      firstMs: 30000,
      advanceNoticeLeadMs: 3000,
      firstLimitMs: 35000,
      snoozeMs: 10000,
      cooldownMs: 2000,
      hardMs: 60000,
      hardRepeatMs: 5000,
      yesGraceMs: 10000,
      idleMs: 2000,
      switchWindowMs: 5000,
      switchIdleMs: 1000,
    },
  };
}

export function validateTimingProfiles(profiles: TimingProfiles): string | null {
  for (const profile of ["normal", "demo"] as const) {
    const values = profiles[profile];
    const label = profile === "normal" ? "通常版" : "デモ版";
    for (const key of timingKeys) {
      const value = values[key];
      const minimum = zeroAllowedTimings.includes(key) ? 0 : 1_000;
      if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMING_MS || value % 1_000 !== 0)
        return `${label}の時間は1秒単位で、${minimum === 0 ? "0秒" : "1秒"}から24時間までの値を指定してください。`;
    }
    if (values.advanceNoticeLeadMs > values.firstMs) return `${label}の予告時間は休憩の目安以下にしてください。`;
    if (values.firstMs > values.firstLimitMs || values.firstLimitMs > values.hardMs)
      return `${label}は「休憩の目安 ≦ 初回通知の上限 ≦ 強調通知の開始時間」にしてください。`;
    if (values.cooldownMs > values.snoozeMs) return `${label}の再通知の抑制時間は再通知の上限以下にしてください。`;
    if (values.switchIdleMs > values.switchWindowMs) return `${label}の切り替え後の無操作時間は切り替えの判定期間以下にしてください。`;
  }
  return null;
}
