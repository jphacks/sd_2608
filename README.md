# ポチ · 休憩のおとも

Windows 上のカメラでの在席確認と PC の使用状況から、座り続けている時間を計測し、休憩を提案する Tauri / React アプリです。通知の **「レポートを作る」で作業レポートを即時作成**します。席を離れた場合は、その確認から5分後に作成し、途中で席に戻っても作成の予約は維持します。

```powershell
npm ci
npm run tauri dev
```

起動時は作業の記録がオフです。ポチの「作業を記録」から、使用する情報と記録に同意して開始します。AI を使わない場合は「この端末だけに記録」または「AI に送信せず記録」を使えます。AI は記録を停止した状態で設定を開き、接続先・モデル・キーを保存してから、開始時に送信先へ同意します。

- [B-08／B-09 の実装・検証記録とデモ手順](docs/backend-integration.md)
- [表示とアニメーションの構成](docs/pochi-typescript.md)
- [表示開発ガイド](docs/ui-development.md)
- [機能仕様](docs/requirements.md) / [バックエンド計画](docs/backend-development-plan.md)
- [全ウィンドウ OCR の仕様・検証](docs/ocr-summary.md)

通常のブラウザー起動 (`npm run dev`) は Tauri 起動案内です。`npm run dev:mock` は実カメラ・PC 取得・外部送信をしない表示開発環境です。A の表示も本番と同じ AppController／AppGateway に接続しています。

## 単体アプリと短縮デモ

Windows の MSVC / Rust / WebView2 Runtime が必要です。顔モデルと日本語・英語の OCR モデル、WASM は同梱し、起動時の CDN ダウンロードはありません。OCR は設定の「ウィンドウの内容を OCR で取得」で切り替えます（初期値オフ）。AI 要約時に背面も含む取得可能な全ウィンドウを読み取り、作業履歴と一致したウィンドウの文字を補足に使います。

```powershell
npm run desktop:build
# src-tauri/target/release/sd_2608.exe（開発サーバー不要）

npm run desktop:demo
# 実カメラ＋実 PC 情報、30〜35秒で通知、離席確定後5秒で作成

npm run desktop:build:demo
# 同じ出力パスに短縮デモの EXE を作成
```

両ビルドは同じ EXE パスを使うため、同時には実行せず、配布時は別名でコピーしてください。インストーラーは `npm run tauri build` で作成できます。実 API の確認・実カメラ・ロック／スリープ・Windows 表示倍率の確認状況は、上記の検証記録に分けて記載します。

## 検証

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

過去の B-01〜07 の実装・検証メモは `docs/backend-*.md` にあります。`handoff/pochi-ja/` は A の旧手動フローと C# 版の参考アーカイブで、現在の起動・配布物ではありません。
