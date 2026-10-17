import { useMemo, useState } from "react";
import { MockGateway } from "../adapters/mock/MockGateway.js";
import { useAppController } from "../application/useAppController.js";
import { AppView } from "../components/AppView.js";
import { scenarios } from "../contracts/fixtures.js";
import type { ScenarioId } from "../contracts/fixtures.js";
import type { PetAnimationId } from "../contracts/presentation.js";
import { petManifest } from "../presentation/petManifest.js";
import "./mock-workbench.css";

export default function MockWorkbench() {
  const gateway = useMemo(() => new MockGateway(), []);
  const { state, actions } = useAppController(gateway);
  const [scenario, setScenario] = useState<ScenarioId>("stopped");
  const [preview, setPreview] = useState<{ animation: PetAnimationId; token: number } | null>(null);
  const selected = scenarios.find(candidate => candidate.id === scenario)!;
  const loadScenario = async (value: ScenarioId) => {
    if (state.pending || state.connection !== "connected") return;
    setScenario(value); setPreview(null);
    await actions.clearData();
    gateway.loadScenario(value);
  };
  const viewState = preview ? { ...state, pet: { ...state.pet, animation: preview.animation,
    pose: petManifest[preview.animation].finalPose, playbackToken: `preview-${preview.token}`, greeting: preview.animation === "welcome" ? "おかえりなさい！" : null } } : state;
  return <>
    <aside className="mock-workbench" aria-label="表示開発用コントロール">
      <h2>表示開発用モック · カメラ・PC 取得・外部通信なし</h2>
      <label>シナリオ <select value={scenario} disabled={state.pending !== null || state.connection !== "connected"} onChange={event => {
        void loadScenario(event.target.value as ScenarioId);
      }}>{scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button disabled={state.pending !== null || state.connection !== "connected"} onClick={() => { void loadScenario(scenario); }}>同じ状態を再現</button>
      <p>{selected.description}</p>
      <div className="actions">
        {[1_000, 10_000, 60_000, 600_000].map(ms => <button key={ms} onClick={() => gateway.advanceBy(ms)}>+{ms < 60_000 ? `${ms / 1_000}秒` : `${ms / 60_000}分`}</button>)}
        <button onClick={() => gateway.detectBoundary()}>新しい区切り</button>
        <button onClick={() => gateway.setPresence("away")}>離席を確定</button>
        <button onClick={() => gateway.setPresence("present")}>帰席を確定</button>
        <button onClick={() => gateway.setPresence("unknown")}>取得不能</button>
      </div>
      <details><summary>7つのアニメーションを個別プレビュー（現在は仮画像）</summary>
        <div className="actions">{(Object.keys(petManifest) as PetAnimationId[]).map(animation =>
          <button key={animation} onClick={() => setPreview({ animation, token: Date.now() })}>{animation}</button>)}
          <button onClick={() => setPreview(null)}>業務状態の表示へ戻る</button>
        </div>
      </details>
      <p>時計は手動です。5分予約は「+1分」を5回、その後「+10秒」で完成します。時間判定は Rust 実装の代替テストではありません。</p>
    </aside>
    <AppView state={viewState} actions={actions} petManifest={petManifest} />
  </>;
}
