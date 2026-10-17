# サンプル（プロダクト名）

## 開発者向け

表示担当は `npm ci` → `npm run dev:mock` で、実センサー・API なしの開発画面を開けます。
共通型・操作の接続口・phase3 までのシナリオ・GIF の差し替え方法は、[表示開発ガイド](docs/ui-development.md) を参照してください。
確認コマンドは `npm test` と `npm run build` です。
`npm run tauri dev` では、同意して開始すると PC 情報と顔の有無から在席・休憩通知を判定し、マスク済みの作業履歴を保持します。Yes または離席確定の5分後にカードを作成・表示します。ローカル履歴のほか、接続先・モデル・キーを設定し送信に同意すると Gemini／OpenAI互換APIで要約できます。顔モデル・WASM は同梱し、設定と保存済みカードを復元できます。
[B-01 の接続基盤](docs/backend-runtime-contract.md) / [B-02 のPC情報取得](docs/backend-pc-activity.md) / [B-03 の顔検出](docs/backend-face-detection.md) / [B-04 の在席・通知と検証](docs/backend-presence-reminder.md)

[B-05 の履歴・設定・保存と検証](docs/backend-history-storage.md)

[B-06 のレポート・5分予約と検証](docs/backend-report-coordinator.md)

[B-07 のAI接続・同意・失敗と再試行](docs/backend-ai-provider.md)（ローカルHTTP検証。実サービス検証は別途）

[開発計画・設計書](docs/development-plan.md)

[![IMAGE ALT TEXT HERE](https://jphacks.com/wp-content/uploads/2026/07/IMG_5316.png)](https://www.youtube.com/watch?v=piaNsc6ilBI)

## 製品概要
### 背景(製品開発のきっかけ、課題等）
### 製品説明（具体的な製品の説明）
### 特長
#### 1. 特長1
#### 2. 特長2
#### 3. 特長3

### 解決出来ること
### 今後の展望
### 注力したこと（こだわり等）
* 
* 

## 開発技術
### 活用した技術
#### API・データ
* 
* 

#### フレームワーク・ライブラリ・モジュール
* 
* 

#### デバイス
* 
* 

### 独自技術
#### ハッカソンで開発した独自機能・技術
* 独自で開発したものの内容をこちらに記載してください
* 特に力を入れた部分をファイルリンク、またはcommit_idを記載してください。
