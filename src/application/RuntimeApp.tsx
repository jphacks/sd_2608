import { useMemo, useState } from "react";
import { TauriGateway } from "../adapters/tauri/TauriGateway.js";
import { nativeTransport } from "../adapters/tauri/nativeTransport.js";
import { AppView } from "../components/AppView.js";
import { petManifest } from "../presentation/petManifest.js";
import { useAppController } from "./useAppController.js";
import { FaceDetectionController } from "../adapters/camera/FaceDetectionController.js";
import { browserCamera } from "../adapters/camera/browserCamera.js";
import { browserEnvironment } from "../adapters/tauri/transport.js";

export default function RuntimeApp() {
  const gateway = useMemo(() => new TauriGateway(nativeTransport, browserEnvironment, {
    camera: new FaceDetectionController(browserCamera),
    ...(import.meta.env.DEV ? { manual: new FaceDetectionController(browserCamera, "manual") } : {}),
  }), []);
  const { state, actions } = useAppController(gateway);
  const [manualConsent, setManualConsent] = useState(false);
  const [startingManual, setStartingManual] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  return <>
    <AppView state={state} actions={actions} petManifest={petManifest} />
    {import.meta.env.DEV && <fieldset aria-label="B-03 手動顔入力テスト">
      <legend>開発用：手動の顔入力（カメラ不使用）</legend>
      <label><input type="checkbox" checked={manualConsent} onChange={event => setManualConsent(event.target.checked)} />手動顔入力・PC情報を使った計測と、マスク済み履歴の記録を許可する</label>
      <button disabled={!manualConsent || startingManual || state.pending !== null || state.connection !== "connected" || state.snapshot?.runtime.phase !== "stopped"}
        onClick={() => {
          if (!state.snapshot) return;
          setStartingManual(true); setManualError(null);
          void gateway.startManual({ profile: "demo", expectedSettingsRevision: state.snapshot.settings.revision,
            reportMode: "local", consent: { activity: true, history: true, externalReport: false } })
            .then(result => { if (!result.ok) setManualError(result.error.message); })
            .finally(() => setStartingManual(false));
        }}>手動テストを開始</button>
      <button disabled={state.snapshot?.runtime.profile !== "demo" || state.snapshot.runtime.phase !== "running"} onClick={() => gateway.setManualFaceDetected(true)}>顔あり</button>
      <button disabled={state.snapshot?.runtime.profile !== "demo" || state.snapshot.runtime.phase !== "running"} onClick={() => gateway.setManualFaceDetected(false)}>顔なし</button>
      {manualError && <p role="alert">{manualError}</p>}
    </fieldset>}
  </>;
}
