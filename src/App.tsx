import { lazy, Suspense } from "react";
import "./App.css";
import PochiApp from "./pochi/PochiApp.js";

// The existing sensor/AI workbench remains development-only. The default is the real manual workflow.
const MockWorkbench = import.meta.env.DEV && import.meta.env.MODE === "mock"
  ? lazy(() => import("./dev/MockWorkbench.js")) : null;

export default function App() {
  if (MockWorkbench) return <Suspense fallback={<p>表示開発環境を読み込んでいます…</p>}><MockWorkbench /></Suspense>;
  return <PochiApp />;
}
