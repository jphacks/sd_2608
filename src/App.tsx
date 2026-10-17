import { lazy, Suspense } from "react";
import "./App.css";

// dev:mock 以外ではモックをロードしない。実 Gateway の接続はロジック担当が行う。
const MockWorkbench = import.meta.env.DEV && import.meta.env.MODE === "mock"
  ? lazy(() => import("./dev/MockWorkbench.js")) : null;

export default function App() {
  if (MockWorkbench) return <Suspense fallback={<p>表示開発環境を読み込んでいます…</p>}><MockWorkbench /></Suspense>;
  return <main className="setup-notice">
    <h1>休憩のおとも</h1>
    <p>実センサー・レポート生成の接続は準備中です。</p>
    {import.meta.env.DEV && <p>表示開発は <code>npm run dev:mock</code> で起動してください。</p>}
  </main>;
}
