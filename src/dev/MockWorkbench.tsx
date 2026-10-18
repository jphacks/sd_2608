import { useEffect, useMemo, useRef, useState } from "react";
import { MockGateway } from "../adapters/mock/MockGateway.js";
import { useAppController } from "../application/useAppController.js";
import PochiApp from "../pochi/PochiApp.js";
import { scenarios } from "../contracts/fixtures.js";
import type { ScenarioId } from "../contracts/fixtures.js";
import { initialMotion, moveTo } from "../pochi/animation.js";
import type { ActionId } from "../pochi/animation.js";
import { petManifest } from "../presentation/petManifest.js";
import "./mock-workbench.css";

export default function MockWorkbench() {
  const gateway = useMemo(() => new MockGateway(), []);
  const { state, actions } = useAppController(gateway);
  const windowPreview = new URLSearchParams(location.search).get("window") === "1";
  const [scenario, setScenario] = useState<ScenarioId>(() => {
    const requested = new URLSearchParams(location.search).get("scenario");
    return scenarios.find(value => value.id === requested)?.id ?? "stopped";
  });
  const initialized = useRef(false);
  useEffect(() => {
    if (state.connection === "connected" && !initialized.current) {
      initialized.current = true; gateway.loadScenario(scenario);
    }
  }, [state.connection, gateway, scenario]);
  const [preview, setPreview] = useState<{ animation: ActionId; token: number } | null>(null);
  const selected = scenarios.find(candidate => candidate.id === scenario)!;
  const loadScenario = async (value: ScenarioId) => {
    if (state.pending || state.connection !== "connected") return;
    setScenario(value); setPreview(null);
    await actions.clearData();
    gateway.loadScenario(value);
  };
  const viewState = preview ? { ...state, motion: { ...moveTo(initialMotion(), preview.animation === "rest" ? "rest" : "idle", preview.animation), token: preview.token } } : state;
  return <>
    <aside hidden={windowPreview} className="mock-workbench" aria-label="表示開発用コントロール">
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
      <details><summary>採用済みのアニメーションを個別プレビュー</summary>
        <div className="actions">{(["idle", "reminder", "rest", "record", "welcome", "turn_sit", "rest_to_sit", "sit_to_rest"] as ActionId[]).map(animation =>
          <button key={animation} onClick={() => setPreview({ animation, token: Date.now() })}>{animation}</button>)}
          <button onClick={() => setPreview(null)}>業務状態の表示へ戻る</button>
        </div>
      </details>
      <p>時計は手動です。通知・レポートの待ち時間は設定画面で変更できます。シナリオの読込では初期値に戻ります。時間判定は Rust 実装の代替テストではありません。</p>
    </aside>
    <PochiApp state={viewState} actions={actions} petManifest={petManifest} desktop={windowPreview} />
  </>;
}
