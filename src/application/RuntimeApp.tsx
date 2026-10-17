import { useMemo, useEffect } from "react";
import { TauriGateway } from "../adapters/tauri/TauriGateway.js";
import { nativeTransport } from "../adapters/tauri/nativeTransport.js";
import { nativeWindow } from "../adapters/tauri/WindowAdapter.js";
import PochiApp from "../pochi/PochiApp.js";
import { petManifest } from "../presentation/petManifest.js";
import { useAppController } from "./useAppController.js";
import { FaceDetectionController } from "../adapters/camera/FaceDetectionController.js";
import { browserCamera } from "../adapters/camera/browserCamera.js";
import { browserEnvironment } from "../adapters/tauri/transport.js";

export default function RuntimeApp() {
  const demo = import.meta.env.MODE === "demo";
  const manual = demo && import.meta.env.VITE_MANUAL_FACE === "1";
  const gateway = useMemo(() => new TauriGateway(nativeTransport, browserEnvironment, {
    camera: new FaceDetectionController(browserCamera),
    ...(manual ? { manual: new FaceDetectionController(browserCamera, "manual") } : {}),
  }, nativeWindow, manual), [manual]);
  const { state, actions } = useAppController(gateway);
  useEffect(() => { void actions.placeWindow(); }, [actions]);
  return <>
    <PochiApp state={state} actions={actions} petManifest={petManifest} desktop profile={demo ? "demo" : "normal"} manual={manual} />
    {manual && <div className="pochi-demo-controls" aria-label="デモ専用の手動顔入力">
      <span>短縮デモ・手動顔入力（実カメラ不使用）</span>
      <button disabled={state.snapshot?.runtime.phase !== "running"} onClick={() => gateway.setManualFaceDetected(true)}>顔あり</button>
      <button disabled={state.snapshot?.runtime.phase !== "running"} onClick={() => gateway.setManualFaceDetected(false)}>顔なし</button>
    </div>}
  </>;
}
