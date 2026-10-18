# わんポーズ：開発・実行ガイド

## 開発環境と起動

Windowsのデスクトップ版には、Node.js / npm、Rust（MSVC）、C++ Build Tools、WebView2 Runtimeが必要です。実際の在席確認にはカメラを使います。

リポジトリのルートで実行します。

```powershell
npm ci
npm run tauri dev
```

起動時は記録がオフです。犬の「作業を記録」から、使用する情報と記録に同意して開始します。AIを使わない場合は「この端末だけに記録」または「AI に送信せず記録」を選べます。

AIを使う場合は、記録を停止した状態で設定を開き、API形式・接続先・モデル・キーを保存してから、開始時に送信先へ同意します。「レポートを作る」は即時に生成を始めます。自然な離席では設定した待ち時間の後に生成し、帰席しても予約は維持します。

顔検出モデルと日本語・英語のOCRモデル、WASMは同梱します。`npm ci`やビルド前の準備処理で必要なアセットを配置し、アプリ起動時にはCDNからモデルをダウンロードしません。OCRは設定の「ウィンドウの内容を OCR で取得」で切り替えます（初期値オフ）。

## 通知音と時間の設定

記録を停止してから犬をダブルクリックするか、メニューの歯車で設定を開きます。

- 通知音：「犬の鳴き声」「システム音」「音なし」。初期値は犬の鳴き声です。
- 時間：通知・予告・再通知・離席判定・レポート待機など13項目を通常版とデモ版で別々に保存できます。変更は次の記録開始から反映します。
- 各版の「時間を初期値に戻す」は入力だけを戻します。「設定を保存」で確定してください。

初期値の一覧と入力条件は[時間の設定](timing-settings.md)を参照してください。

## 単体アプリと短縮デモ

```powershell
npm run desktop:build
# src-tauri/target/release/sd_2608.exe（開発サーバー不要）

npm run desktop:demo
# 実カメラ＋実PC情報を使う短縮デモ

npm run desktop:build:demo
# 同じ出力パスに短縮デモのEXEを作成
```

初期設定では、通常版は30〜35分、デモ版は30〜35秒で休憩を提案します。離席は通常30秒・デモ5秒で確定し、確定後のレポート待機は通常5分・デモ5秒です。これらは設定画面から変更できます。

両ビルドは同じEXEパスを使うため、配布時は別名でコピーしてください。インストーラーは `npm run tauri build` で作成できます。

## ブラウザーでの表示開発

```powershell
npm run dev:mock
```

実カメラ・PC情報の取得・外部AI送信を行わない、手動時計の表示開発環境です。本番と同じ画面とAppController / AppGatewayを使います。通常の `npm run dev` をブラウザーで開くと、Tauriでの起動案内を表示します。

## 自動検証

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked

# ヘッドレスブラウザーでDOMを検証
npm run test:ui
```

実カメラ・Windowsの実操作・実APIの確認範囲は[統合・検証記録](backend-integration.md)に記載しています。

## 実装資料

- [機能仕様](requirements.md) / [アーキテクチャ](architecture.md)
- [表示とアニメーションの構成](pochi-typescript.md) / [表示開発ガイド](ui-development.md)
- [時間設定](timing-settings.md) / [全ウィンドウOCR](ocr-summary.md)
- [履歴と設定の保存](backend-history-storage.md) / [データモデル](data-model.md)

コード内の `pochi` は犬の「ポチ」に由来する既存の識別子です。製品名は「わんポーズ」です。
