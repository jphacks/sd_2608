import { lazy, Suspense } from "react";
import { isTauri } from "@tauri-apps/api/core";
import "./App.css";

// dev:mock 以外ではモックをロードしない。実 Gateway の接続はロジック担当が行う。
const MockWorkbench = import.meta.env.DEV && import.meta.env.MODE === "mock"
  ? lazy(() => import("./dev/MockWorkbench.js")) : null;
const RuntimeApp = lazy(() => import("./application/RuntimeApp.js"));

export default function App() {
  if (MockWorkbench) return <Suspense fallback={<p>表示開発環境を読み込んでいます…</p>}><MockWorkbench /></Suspense>;
  if (isTauri()) return <Suspense fallback={<p>アプリへ接続しています…</p>}><RuntimeApp /></Suspense>;
  return <main className="setup-notice">
    <h1>休憩のおとも</h1>
    <p>実アプリへの接続には Tauri での起動が必要です。</p>
    {import.meta.env.DEV && <p><code>npm run tauri dev</code> で起動できます。監視・レポート生成はまだ未接続です。</p>}
    {import.meta.env.DEV && <p>表示開発は <code>npm run dev:mock</code> で起動してください。</p>}
  </main>;
}
