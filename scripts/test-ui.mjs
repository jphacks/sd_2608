import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// 画面やスクリーンショットを使わず、ヘッドレス Chromium の DOM の結果だけを読む。
const root = path.resolve(import.meta.dirname, "..");
const browser = [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(candidate => candidate && fs.existsSync(candidate));
if (!browser) throw new Error("CHROME_PATH に Chromium ブラウザーの実行ファイルを指定してください。");
const artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const profile = fs.mkdtempSync(path.join(artifacts, "ui-test-chromium-"));
const origin = "http://127.0.0.1:1437";
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--mode", "mock",
  "--host", "127.0.0.1", "--port", "1437", "--strictPort"], { cwd: root, stdio: "ignore", windowsHide: true });
let chrome, socket;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("表示テスト用の Vite が起動できませんでした（1437番ポートを確認）。");
    try { if ((await fetch(origin)).ok) { ready = true; break; } }
    catch (error) { if (error.cause?.code === "EACCES") throw new Error("ローカルサーバーへの接続が実行環境で制限されています。", { cause: error }); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("表示テスト用の Vite の起動がタイムアウトしました。");
  chrome = spawn(browser, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-extensions", "--disable-sync", "--disable-background-timer-throttling",
    `--user-data-dir=${profile}`, "--remote-debugging-port=1438", "--window-size=440,760", "about:blank"],
  { cwd: root, stdio: "ignore", windowsHide: true });
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { target = (await (await fetch("http://127.0.0.1:1438/json/list")).json()).find(tab => tab.type === "page"); } catch {}
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!target) throw new Error("ヘッドレスブラウザーに接続できませんでした。");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10_000);
    pending.set(id, message => { clearTimeout(timeout); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call("Emulation.setDeviceMetricsOverride", { width: 440, height: 760, deviceScaleFactor: 1, mobile: false });
  for (const page of ["pet-ui-smoke", "advance-notice-smoke", "window-click-through-smoke"]) {
    await call("Page.navigate", { url: `${origin}/tests/browser/${page}.html` });
    let output;
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const result = await call("Runtime.evaluate", { expression: 'document.querySelector("#result")?.textContent', returnByValue: true });
      output = result.result?.value;
      if (output && output !== "loading") break;
    }
    if (!output?.includes('"result": "PASS"')) throw new Error(`${page}: ${output ?? "ページが読み込めませんでした。"}`);
    console.log(`${page}: ${output}`);
  }
} finally {
  socket?.close();
  if (chrome) {
    const exited = new Promise(resolve => chrome.once("exit", resolve));
    chrome.kill();
    await exited;
  }
  server.kill();
  // このスクリプトで作ったリポジトリ内の一時プロファイルだけを削除する。
  if (path.dirname(profile) !== artifacts || !path.basename(profile).startsWith("ui-test-chromium-"))
    throw new Error("ブラウザーの一時出力先が想定外です。");
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
