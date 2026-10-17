import { useMemo } from "react";
import { TauriGateway } from "../adapters/tauri/TauriGateway.js";
import { nativeTransport } from "../adapters/tauri/nativeTransport.js";
import { AppView } from "../components/AppView.js";
import { petManifest } from "../presentation/petManifest.js";
import { useAppController } from "./useAppController.js";

export default function RuntimeApp() {
  const gateway = useMemo(() => new TauriGateway(nativeTransport), []);
  const { state, actions } = useAppController(gateway);
  return <AppView state={state} actions={actions} petManifest={petManifest} />;
}
