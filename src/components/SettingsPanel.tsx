import { useState } from "react";
import type { SettingsPanelProps } from "../contracts/ui.js";
import type { ProviderSettings } from "../contracts/domain.js";
import { createTimingProfiles, validateTimingProfiles } from "../contracts/timings.js";
import { timingFields, timingUnitMs } from "../presentation/timingSettings.js";
import { TimingSettingsFields } from "./TimingSettingsFields.js";

export function SettingsPanel({ settings, disabled, onSave, profile }: SettingsPanelProps) {
  const [timingError, setTimingError] = useState<string | null>(null);
  return <form className="settings-panel" onSubmit={event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const kind = text("provider") === "gemini" ? "gemini" : "openAiCompatible";
    const provider: ProviderSettings | null = text("endpoint") || text("model") ?
      { kind, endpoint: text("endpoint"), model: text("model") } : null;
    const keyKind = text("keyChange");
    const timings = createTimingProfiles();
    for (const mode of ["normal", "demo"] as const) {
      for (const field of timingFields) timings[mode][field.key] = Math.round(Number(text(`timings.${mode}.${field.key}`)) * timingUnitMs(mode, field));
    }
    const error = validateTimingProfiles(timings);
    setTimingError(error);
    if (error) return;
    void onSave({
      expectedSettingsRevision: settings.revision,
      values: { reportMode: text("reportMode") === "ai" ? "ai" : "local", provider,
        excludedApps: text("excludedApps").split(/\r?\n/).map(app => app.trim()).filter(Boolean),
        reducedMotion: data.get("reducedMotion") === "on", ocrEnabled: data.get("ocrEnabled") === "on",
        notificationSound: text("notificationSound") === "system" ? "system" : text("notificationSound") === "none" ? "none" : "dog", timings },
      keyChange: keyKind === "replace" ? { kind: "replace", value: text("apiKey") } :
        keyKind === "remove" ? { kind: "remove" } : { kind: "keep" },
    }).finally(() => { const key = form.elements.namedItem("apiKey"); if (key instanceof HTMLInputElement) key.value = ""; });
  }}>
    <h2>設定</h2><p>作業の記録を停止すると、設定を変更できます。保存済みの API キーは表示しません。</p>
    <fieldset disabled={disabled}>
      <label>通知音<select name="notificationSound" defaultValue={settings.notificationSound}><option value="dog">犬の鳴き声</option><option value="system">システム音</option><option value="none">音なし</option></select></label>
      {timingError && <p role="alert">{timingError}</p>}
      <TimingSettingsFields timings={settings.timings} profile={profile} />
      <label>レポートの作成方法<select name="reportMode" defaultValue={settings.reportMode}><option value="local">端末内の記録</option><option value="ai">AI 要約</option></select></label>
      <label>API 形式<select name="provider" defaultValue={settings.provider?.kind ?? "openAiCompatible"}><option value="openAiCompatible">OpenAI 互換</option><option value="gemini">Gemini</option></select></label>
      <label>接続先<input name="endpoint" type="url" defaultValue={settings.provider?.endpoint ?? ""} placeholder="https://example.invalid/v1/chat/completions" /></label>
      <p>OpenAI 互換は Chat Completions の完全な URL、Gemini はベース URL（例: https://generativelanguage.googleapis.com/v1beta）を指定します。HTTPS を使い、端末内のテスト API のみ HTTP を使えます。</p>
      <label>モデル<input name="model" defaultValue={settings.provider?.model ?? ""} /></label>
      <label>キーの変更<select name="keyChange" defaultValue="keep"><option value="keep">変更しない（{settings.hasApiKey ? "登録済み" : "未登録"}）</option><option value="replace">登録・差し替え</option><option value="remove">削除</option></select></label>
      <label>新しい API キー<input name="apiKey" type="password" autoComplete="new-password" /></label>
      <label>除外アプリ（1行1件）<textarea name="excludedApps" defaultValue={settings.excludedApps.join("\n")} /></label>
      <label className="check"><input name="reducedMotion" type="checkbox" defaultChecked={settings.reducedMotion} />動きを減らす</label>
      <label className="check"><input name="ocrEnabled" type="checkbox" defaultChecked={settings.ocrEnabled} />ウィンドウの内容を OCR で取得</label>
      <p>オンの場合、AI 要約の作成時に全ウィンドウを読み取り、作業履歴と一致するウィンドウの文字を要約に使います。画像は保存・送信しません。最小化・保護・除外対象など、取得できないウィンドウはスキップします。</p>
      <button type="submit">設定を保存</button>
    </fieldset>
  </form>;
}
