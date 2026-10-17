# ポチ：日本語版プログラムとアニメーションの引き継ぎ

表示担当から共有する、現時点で採用している素材と実行可能なWindows参考実装です。個人の作業記録、実際の入力メモ、APIキー、ローカルテストデータは含めていません。

プログラム、全ソース、アニメーション、元プロトタイプをすべてこのPRの `handoff/pochi-ja/` に含めています。以下のファイル名を開き、GitHubの「Download raw file」から保存してください。ブランチ全体の「Code → Download ZIP」でも一括取得できます。

## まず使うファイル

| ファイル | 内容・使い方 |
| --- | --- |
| [pochi-desktop-ja.zip](./pochi-desktop-ja.zip) | 日本語版Windowsアプリ1.1。解凍して `Pochi.exe` を起動。説明書同梱 |
| [pochi-desktop-ja-source.zip](./pochi-desktop-ja-source.zip) | C# / WPF の全ソース、ビルドスクリプト、107枚の透過PNG、検証結果。解凍先の `pochi-desktop/build.ps1 -Test` でビルドと自動テスト |
| [puppy-png-frames-v8.zip](./puppy-png-frames-v8.zip) | 7グループ・107枚、各512×512の透過RGBA PNG。アクションごとの `manifest.json` と `timings.csv` にフレーム順序と表示時間を記載 |
| [puppy-transparent-gifs-v8.zip](./puppy-transparent-gifs-v8.zip) | 7グループ、512×512、透過背景のGIF。解凍後の `index.html` で背景色を変えて確認可能 |
| `workflow-ja.md` | ユーザー指定の11段階の操作と現在の動作の対応 |
| [prototype-original.html](./prototype-original.html) | ユーザーから受領した元の対話プロトタイプ。旧文言・旧アニメーション割り当てを含む参考資料 |
| `verification-ja.json` | 日本語版の196項目の自動チェック結果。107枚のPNGが元データと一致することも確認 |

## このリポジトリとの関係

リポジトリ本体はReact / Tauri、今回の実行可能な参考実装はC# / WPFです。参考実装をそのままTauriの完成版として扱わず、表示・操作・記録処理と素材を取り込む際の参照にしてください。この引き継ぎでは既存の契約、Gateway、Rustのコードは変更していません。

Tauri側の既存の接続口は `src/presentation/petManifest.ts` です。PNGの連続再生にするか、透過GIFを配置して差し替えるかを選べます。以下が素材の対応表です。

| 素材ID | 枚数 | 1回の時間 | 用途 |
| --- | ---: | ---: | --- |
| `idle` | 8 | 3600ms | お座りで待機・呼吸・まばたき |
| `reminder` | 8 | 1440ms | 休憩のお知らせ |
| `rest` | 14 | 4200ms | 伏せ・しっぽ・耳・呼吸のループ |
| `record` | 8 | 1760ms | しおりで作業を記録 |
| `welcome` | 20 | 2710ms | おかえり・まばたき・手を振る |
| `turn_sit` | 23 | 3320ms | 一周して元の場所に座る |
| `rest_to_sit` | 26 | 2530ms | 伏せから起き上がり、踏み替えて正面に座る（第3版） |

Tauriの `idleRest` → `rest`、`welcome` → `welcome`、`lieToSit` → `rest_to_sit` が直接の対応です。`recordReminder` は文脈に応じて `record` または `reminder` を選びます。

**`sitToLie` に `turn_sit` を割り当てないでください。** `turn_sit` は一周して座る別動作です。Windows版では `rest_to_sit` のPNGと各フレームの時長を逆順にして「お座り→伏せ」を再生しています。走り込み専用の素材はこの7グループにはありません。

GIFはすべて確認用に繰り返し再生します。アプリでは開始・停止と1回再生を制御し、正式なループ設定・フレーム時間はPNG側のmanifestを参照してください。GIFの透過は2値、PNGは元の半透明の輪郭を保持します。

## Windows参考実装の操作

- ポチをダブルクリック：設定。「保存してもどる」で確定。
- クリック：作業入力。もう一度クリックするか開始ボタンで記録開始。
- 作業中は伏せて待機。通知時に起き上がり、休憩をすすめる。
- 「はい・休憩する」：休憩を1回追加し、進捗と困りごとを入力。
- 「いいえ・今は続ける」：休憩回数を増やさず、一定時間後に再通知。
- 「戻ったよ」：起き上がり、おかえり動作の後に作業を継続。
- 「記録を見る」：作業・休憩の時間、回数、各メモをアプリ内で確認。
- 終了時にレポートを保存し、次回起動時にもアプリ内で表示。

記録は通常 `%LOCALAPPDATA%\PochiDesktop\pochi-data.json` に保存します。カメラ検出と音声入力、外部AIとの通信は参考実装には未接続です。

## 確認済み・未確認

- Windows版はコンパイル済み。自動チェック196項目に合格。
- 全107枚のPNGのSHA-256が採用済みデータと一致。
- 日本語UIの起動を確認済み。全画面を通した自動操作試験は未完了。
- 元プロトタイプの見た目は参考用で、旧設定・中国語の文言・誤った「坐→伏せ」の割り当てを含みます。現在の操作はWindows版と `workflow-ja.md` を参照してください。
