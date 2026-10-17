import type { SettingsPanelProps } from "../contracts/ui.js";
import type { ProviderSettings } from "../contracts/domain.js";

export function SettingsPanel({ settings, disabled, onSave }: SettingsPanelProps) {
  return <form className="settings-panel" onSubmit={event => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();
    const kind = text("provider") === "gemini" ? "gemini" : "openAiCompatible";
    const provider: ProviderSettings | null = text("endpoint") || text("model") ?
      { kind, endpoint: text("endpoint"), model: text("model") } : null;
    const keyKind = text("keyChange");
    void onSave({
      expectedSettingsRevision: settings.revision,
      values: { reportMode: text("reportMode") === "ai" ? "ai" : "local", provider,
        excludedApps: text("excludedApps").split(/\r?\n/).map(app => app.trim()).filter(Boolean),
        reducedMotion: data.get("reducedMotion") === "on" },
      keyChange: keyKind === "replace" ? { kind: "replace", value: text("apiKey") } :
        keyKind === "remove" ? { kind: "remove" } : { kind: "keep" },
    }).finally(() => { const key = form.elements.namedItem("apiKey"); if (key instanceof HTMLInputElement) key.value = ""; });
  }}>
    <h2>設定</h2><p>変更は監視を停止してから行います。キーは読み戻しません。</p>
    <fieldset disabled={disabled}>
      <label>レポート方式<select name="reportMode" defaultValue={settings.reportMode}><option value="local">ローカル履歴</option><option value="ai">AI 要約</option></select></label>
      <label>API 形式<select name="provider" defaultValue={settings.provider?.kind ?? "openAiCompatible"}><option value="openAiCompatible">OpenAI 互換</option><option value="gemini">Gemini</option></select></label>
      <label>接続先<input name="endpoint" type="url" defaultValue={settings.provider?.endpoint ?? ""} placeholder="https://example.invalid/v1/chat/completions" /></label>
      <p>OpenAI 互換は Chat Completions の完全な URL、Gemini はベース URL（例: https://generativelanguage.googleapis.com/v1beta）を指定します。HTTPS を使い、端末内のテスト API のみ HTTP を使えます。</p>
      <label>モデル<input name="model" defaultValue={settings.provider?.model ?? ""} /></label>
      <label>キーの変更<select name="keyChange" defaultValue="keep"><option value="keep">変更しない（{settings.hasApiKey ? "登録済み" : "未登録"}）</option><option value="replace">登録・差し替え</option><option value="remove">削除</option></select></label>
      <label>新しい API キー<input name="apiKey" type="password" autoComplete="new-password" /></label>
      <label>除外アプリ（1行1件）<textarea name="excludedApps" defaultValue={settings.excludedApps.join("\n")} /></label>
      <label className="check"><input name="reducedMotion" type="checkbox" defaultChecked={settings.reducedMotion} />動きを減らす</label>
      <button type="submit">設定を保存</button>
    </fieldset>
  </form>;
}
