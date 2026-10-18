import { useMemo, useEffect, useRef } from "react";
import { TauriGateway } from "../adapters/tauri/TauriGateway.js";
import { nativeTransport } from "../adapters/tauri/nativeTransport.js";
import { nativeWindow } from "../adapters/tauri/WindowAdapter.js";
import { startNativeClickThrough } from "../adapters/tauri/startClickThrough.js";
import { startBrowserOcr } from "../adapters/ocr/browserOcr.js";
import PochiApp from "../pochi/PochiApp.js";
import { petManifest } from "../presentation/petManifest.js";
import { useAppController } from "./useAppController.js";
import { FaceDetectionController } from "../adapters/camera/FaceDetectionController.js";
import { browserCamera } from "../adapters/camera/browserCamera.js";
import { browserEnvironment } from "../adapters/tauri/transport.js";

export default function RuntimeApp() {
  const demo = import.meta.env.MODE === "demo";
  const gateway = useMemo(() => new TauriGateway(nativeTransport, browserEnvironment, {
    camera: new FaceDetectionController(browserCamera),
  }, nativeWindow), []);
  const { state, actions } = useAppController(gateway);
  const clickThroughCleanup = useRef(Promise.resolve());
  useEffect(() => startBrowserOcr(), []);
  useEffect(() => { void actions.placeWindow(); }, [actions]);
  useEffect(() => {
    // StrictMode / Fast Refresh では、前の制御による解除が完了してから再開する。
    const stop = startNativeClickThrough(clickThroughCleanup.current);
    return () => { clickThroughCleanup.current = stop(); };
  }, []);
  return <PochiApp state={state} actions={actions} petManifest={petManifest} desktop profile={demo ? "demo" : "normal"} />;
}
