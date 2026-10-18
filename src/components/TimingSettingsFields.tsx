import type { TimingProfile, TimingProfiles } from "../contracts/domain.js";
import { createTimingProfiles, MAX_TIMING_MS, zeroAllowedTimings } from "../contracts/timings.js";
import { timingFields, timingUnitMs } from "../presentation/timingSettings.js";

export function TimingSettingsFields({ timings, profile = "normal" }: { timings: TimingProfiles; profile?: TimingProfile }) {
  return <section className="timing-settings" aria-label="時間の設定">
    <h3>時間の設定</h3>
    <p>通常版とデモ版を別々に保存します。変更は次に記録を始めたときから反映されます。1秒単位、最大24時間で設定できます。</p>
    {(["normal", "demo"] as const).map(mode => <details key={mode} open={mode === profile}>
      <summary>{mode === "normal" ? "通常版の時間" : "デモ版の時間"}</summary>
      {timingFields.map(field => {
        const unit = timingUnitMs(mode, field);
        const name = `timings.${mode}.${field.key}`;
        return <label key={field.key} htmlFor={name}>{field.label}（{unit === 60_000 ? "分" : "秒"}）
          <input id={name} name={name} type="number" required step="any"
            min={(zeroAllowedTimings.includes(field.key) ? 0 : 1_000) / unit} max={MAX_TIMING_MS / unit}
            defaultValue={timings[mode][field.key] / unit} aria-describedby={`${name}.help`}
            onInvalid={event => { const details = event.currentTarget.closest("details"); if (details) details.open = true; }} />
          <small id={`${name}.help`}>{field.help}</small>
        </label>;
      })}
      <button type="button" onClick={event => {
        const defaults = createTimingProfiles()[mode];
        for (const field of timingFields) {
          const input = event.currentTarget.form?.elements.namedItem(`timings.${mode}.${field.key}`);
          if (input instanceof HTMLInputElement) input.value = String(defaults[field.key] / timingUnitMs(mode, field));
        }
      }}>{mode === "normal" ? "通常版" : "デモ版"}の時間を初期値に戻す</button>
    </details>)}
  </section>;
}
