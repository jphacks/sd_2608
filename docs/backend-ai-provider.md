# B-07：AI Provider と失敗時の扱い

対象：`feat/backend-ai-provider`。B-06 を `develop/backend` にマージした `639a4e4` から分岐。[B担当の計画](backend-development-plan.md) の B-07、[機能仕様](requirements.md) の AC-08 に対応する。

## 実装した範囲

| 配置 | 責務 |
|---|---|
| `ports/report_provider.rs` | ReportProvider、送信先・モデルの共通検証 |
| `infrastructure/providers/` | Gemini / OpenAI互換HTTP、認証、取消、応答検証、固定エラーへの変換 |
| `application/app_service/reports.rs` | 固定入力でのAI生成、失敗カードの保存、世代による破棄 |
| `application/{persistence,report_coordinator}.rs` | キー参照の固定、送信時だけの復号、現在の設定による再試行 |
| `components/{AppView,SettingsPanel}.tsx` | 実送信先の説明、開始時の同意、ローカル開始、AI再試行時の確認 |

共通DTO・AppGateway・AのPropsは変更していない。通知・在席・離席予約の判定も従来のDomainを使う。UIの変更は送信同意と設定説明の接続に限る。

## 開始・固定・再試行

- AI開始には、最新の設定revision、接続先・モデル・キーの登録、activity / history / externalReportへの同意が必要。設定保存は停止中だけ。設定変更と停止後は画面の同意チェックを解除する。
- 未同意なら「AI送信せず開始」でローカルモードを明示的に選べる。設定不備や通信失敗をAI成功に置き換えない。
- Yes／離席予約時に、マスク済み履歴、設定全体とrevision、同意、モード、秘密の保存IDをコピーする。ジョブのgenerationとattemptで実行を識別する。平文キーはジョブ・snapshot・カードへ入れない。
- 復号は実行直前。設定画面へキーを読み戻さず、HTTP中は状態・保存のどちらのロックも保持しない。ローカルモードと空履歴では復号も通信もせず、従来のlocalカードを作る。
- failedの明示的再試行だけを許し、同じID・履歴・作成時刻を維持する。現在の監視の設定・同意・キー参照を固定し直し、attemptを増やす。現在の方式がAIなら毎回、送信先URL・モデルを確認するため、送信先を変えた場合も確認を省略しない。

## 通信と出力

| 項目 | 実装 |
|---|---|
| Gemini | endpointはベースURL。`/models/{model}:generateContent`を追加し、`x-goog-api-key`を使う。`systemInstruction`と`contents`を分離、JSON応答を指定 |
| OpenAI互換 | endpointはChat Completionsの完全なURL。Bearer認証、model・system/user messages・`stream:false`。互換性のため追加のresponse_formatは要求しない |
| モデル | 利用者が指定し、既定モデルを埋め込まない。Geminiのモデルは単一のパス要素に制限。互換APIの`org/model`形式は利用可能 |
| 本文 | 固定履歴のアプリ名・マスク済みタイトル・区間時刻・対象期間のみ。内部ID、PID、顔情報、キーを本文へ含めない |
| 指示 | 観測データをuser側のJSONに分離し、タイトル内の命令を実行しないよう明示。作業成果・姿勢・健康状態を断定しない日本語の休憩提案 |
| 制限 | 全体60秒、接続10秒、並列1件、リダイレクト・自動再試行なし。OSプロキシを自動利用しない |
| URL | HTTPS、またはloopback HTTP。認証情報・query・fragment・制御文字を拒否。設定保存／開始／送信直前で共通検証 |
| 応答 | HTTP本文全体64 KiB。Content-Lengthと分割受信の両方で制限。完了した通常のテキスト応答だけを採用し、Geminiのthought部分は除外 |
| 内容 | 必須のsummary（空不可・2,000文字以内）、observedFacts（10件以内・各空不可300文字）、nextAction（nullまたは空不可500文字）。未知プロパティ・欠落・型違い・途中終了を拒否 |

文字数はUnicodeの文字単位で数える。コードフェンスを含む文章は厳密なJSONではないため失敗とする。キーが応答本文に反射された場合は置換し、置換後も出力上限を確認する。

認証失敗はpermissionDenied、HTTPエラー・接続障害はnetworkFailure、期限超過はtimeout、応答不正はinvalidResponse。生の通信エラーやレスポンスをUI・ログへ流さず、固定文言のfailedカードを保存する。元の固定履歴は保持し、自動で再送信しない。

Stop／削除は世代を先に無効化し、実行中のHTTPを25ms間隔で取消確認する。遅い名前解決の終了も待たずワーカーを解放する。古い応答・保存・completionSeqは復活させない。既に送信した内容を相手側から取り消す処理ではない。

## 検証

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm.cmd run tauri -- build --debug --no-bundle
```

検証では架空履歴・ダミーキー・一時保存先を使う。ローカルHTTP検証と実サービスでの確認は区別する。

2026-10-17の確認結果：Rustは94単体テスト＋登録済みIPCテスト1件、フロントは84件すべて成功。`cargo fmt --check`、TypeScript／Vite build、Windows版Tauri debug build（no-bundle）も成功した。Windowsの保存・DPAPIを含むテストは、この実行環境のサンドボックス外の通常権限で実行した。ビルドしたアプリは起動していない。

- ローカルHTTP：両形式のパス・認証ヘッダー・本文、401／403／429／500、リダイレクト先へ未接続、接続失敗、タイムアウト、取消、不正JSON、宣言サイズとchunked双方の過大応答。
- 応答検証：Unicode文字数の境界、件数・型・必須nullable・未知キー・途中終了、キー反射の除去。
- ワーカー結合：AI成功と失敗カードの保存、旧設定・キー参照の固定、再試行時の最新設定とキー、元履歴の不変性、重複再試行、同意・revision拒否、空履歴とlocalで未接続、通信中の読出し・Stop・削除と完了破棄、並列実行の防止。
- 実サービス：未実施。実APIキー・実作業履歴は使用していない。架空履歴によるGemini／利用予定の互換サービスでの認証・モデル対応確認は、キーを設定した実機で別途行う。
- 実WebViewでの同意操作、実カメラと組み合わせた生成、ロック・スリープ復帰は未実施。B-08／09の統合確認に残す。

## 移植・依存・参照

試作版 `break-support-pet` の `9ff7cf0d3c6b72a382d64a196556ae757de0c99f` にある `src-tauri/src/summary/provider.rs` の通信形式を参考に移植した。出力は新DTOへ合わせ、OCR、コードフェンスの補正、旧visibleFacts／nextStepSuggestionを持ち込まない。

依存追加はreqwest（JSON・rustls）とTokio（専用スレッド内の非同期HTTP・期限・取消）。Cargo.lockも更新する。WindowsのTLS証明書検証を利用し、検証を無効化しない。

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)：Bearer認証、model/messages、完了レスポンス。
- [Gemini GenerateContent](https://ai.google.dev/api/generate-content)、[APIキー](https://ai.google.dev/gemini-api/docs/api-key)：systemInstruction、contents、JSON応答指定、認証ヘッダー。
- [reqwest ClientBuilder](https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html)、[retry::never](https://docs.rs/reqwest/0.13.5/reqwest/retry/fn.never.html)：HTTP制限と自動再試行の明示的な無効化。
