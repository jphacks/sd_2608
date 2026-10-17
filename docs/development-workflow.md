# 開発環境・Git 運用

作成日：2026-10-17。2人での並行開発と、Windows 実機での早期統合を前提とする。構成・API・機能の詳細は [アーキテクチャ](architecture.md)、[API 設計](api-design.md)、[機能仕様](requirements.md) を参照。

## 1. 現在の環境と、これから整えるもの

| 項目 | 現状・方針 |
|---|---|
| 開発先 | `sd_2608`。origin は `https://github.com/jphacks/sd_2608` |
| 現在のコード | Tauri 2 / React 19 / TypeScript 6 / Vite 8 の初期構成 |
| 確認したローカルツール | Node 22.12.0、npm 10.9.0、Rust / Cargo 1.99.0 |
| OS | 統合・デモは Windows。Windows 11 x64 をチームの基準環境とする案 |
| 依存固定 | `package-lock.json` と `src-tauri/Cargo.lock` を共有。通常の取得は `npm ci` |
| 現在使える npm コマンド | `dev`、`build`、`preview`、`tauri` |
| 未整備 | モックモード、顔モデル資産準備、フロントテスト、CI、Node / Rust 版固定 |

上記はこの端末の確認値で、2人の環境での動作確認を保証するものではない。最初に両端末で起動・ビルドを確認し、問題がなければ `.node-version` に `22.12.0`、`rust-toolchain.toml` に `1.99.0` を固定する。採用版を変える場合は2人で確認し、CI も同時に更新する。

## 2. 初回セットアップ

Windows の全体開発には Git、Node / npm、MSVC 系 Rust、Visual Studio の C++ デスクトップ開発ツールと Windows SDK、WebView2 Runtime、実カメラを用意する。詳しい導入手順は試作版の [環境構築資料](../../break-support-pet/docs/team-development.md) を参考にし、アプリのパスとコマンドは本書に合わせる。

リポジトリを取得する場合：

```powershell
git clone https://github.com/jphacks/sd_2608.git
cd sd_2608
```

既存の `sd_2608` を使う場合は clone せず、そのディレクトリで以下を実行する。

```powershell
node --version
npm --version
rustc --version
cargo --version
rustup show active-toolchain
npm ci
npm run tauri dev
```

`npm run tauri dev` が Vite も起動する。プロトタイプと本番はどちらもポート1420を使うため、同時起動しない。現在は初期画面が表示されることを確認する段階であり、ペット・カメラ・通知は未実装。

## 3. 並行開発用に追加する環境

以下は **土台フェーズで追加する予定**。この文書の作成時点では未実装なので、整備前にコマンドが使える前提にしない。

| 追加するもの | 内容・完了条件 |
|---|---|
| `npm run dev:mock` | `vite --mode mock`。MockGateway を選択し、カメラ・Rust・実 API なしで UI を開く |
| `npm test` | Vitest を導入。Presenter、Gateway 契約、アニメーション割り込みを確認 |
| 顔モデルの準備 | プロトタイプから MediaPipe の依存・モデル・ライセンスを移植。ビルド前に対応 WASM をコピーするスクリプトを追加 |
| 共通フィクスチャー | `src/contracts/fixtures/`。30分・No・区切り・60分・離席5分・成功／失敗カードを再現 |
| Windows CI | フロント・Rust のテストとビルド。実 API キーやカメラを要求しない |
| 表示資産 | GIF manifest とお座り／伏せの静止画像。未完成 GIF は代替画像で操作を確認できる |

モックの手動時刻操作・顔有無操作は開発モードの専用画面にだけ出す。本番ビルドではモックを選択できないようにする。UI 担当はモックで作業し、Windows 実機の透過・最前面・ドラッグ・表示倍率は統合時に確認する。

顔モデル・WASM は同梱し、実行時の CDN 取得を必要としない。今回使わない OCR・撮影関連パッケージやデータを一括導入しない。

## 4. 担当とファイルの所有

| 担当 | 主な所有範囲 | 共同作業の境界 |
|---|---|---|
| A：表示 | `src/components/`、`src/styles/`、`src/presentation/`、`public/pet/` | Props・表示イベント・GIF manifest は B と接続確認 |
| B：ロジック・統合 | `src/application/`、`src/ports/`、`src/adapters/`、`src-tauri/src/`、`src/App.tsx` | `src/contracts/` の変更は A と合意 |
| B を編集窓口にする共通ファイル | `package.json` と lock、Cargo 定義と lock、Tauri / Vite / TypeScript 設定、CI | A が依存・権限・ウィンドウ変更を必要としたら、要件を Issue に記載 |
| 共同 | `docs/`、README、デモ手順 | 更新する文書・節を先に共有 |

共通の型と MockGateway を先に統合し、その後に各担当が実装する。待ち合わせは実機能の完成時ではなく、契約を決める時点に置く。

## 5. Git・Issue・PR の流れ

1. Issue に目的、担当、対象ファイル、受入条件（AC 番号）、依存する Issue を記載する。
2. 作業前に `git status` を確認し、他の人の未コミット変更を含めない。`git fetch origin` 後、GitHub で確認した既定ブランチの最新から作業ブランチを作る。現在の `chore/setup` を既定ブランチと決めつけない。
3. ブランチ名は `feat/pet-stage`、`feat/sitting-policy`、`fix/report-dedup`、`docs/api-contract` など、変更目的を表す名前にする。
4. UI と実ロジックを別 PR にし、共通契約の変更は先行 PR として統合する。短い単位で push し、未完成でも Draft PR で境界を確認できるようにする。
5. 相手が内容と確認結果をレビューしてから既定ブランチへマージする。通常は squash merge を使い、Issue と変更理由を残す。
6. 統合後は2人とも最新を取得して接続を確認する。共有ブランチへの force push、相手の作業の上書き、無断の lock 再生成は行わない。

PR には「何ができるようになるか」「確認した操作・テスト」「未解決事項」を記載する。UI 変更には画像・短い動画、ロジック変更には仕様の該当箇所と境界条件の確認結果を付ける。

依存追加は定義ファイルと lock を同じ PR で更新する。全体整形や大規模リネームを機能変更に混ぜない。移植元コミット `9ff7cf0d3c6b72a382d64a196556ae757de0c99f` と再利用範囲を記載し、既存コードと今回の追加点を追跡できるようにする。

## 6. 確認コマンドと CI

現状の初期構成でも使える確認：

```powershell
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

土台整備後は `npm test` も必須チェックにする。CI は Windows runner で、採用した Node / Rust の版を使い、`npm ci` → 顔資産準備 → フロントテスト・ビルド → Rust 整形・テストを実行する。インストーラーの生成は日常の PR チェックと分ける。

| 対象 | 主な検証 |
|---|---|
| Rust Domain | 注入時計で30分・35分・No 後2〜10分・60分・自然離席5分・Yes 猶予を確認 |
| ReportCoordinator | 同時 Yes／離席、同一イベント再送、旧予約と新セッション、停止・削除・再試行の競合 |
| TS 契約・Presenter | fixture の型検査、古い revision の破棄、再接続、完成カードの即表示・キュー |
| GIF | 再生時間終了、演出割り込み、古いタイマー、欠損、動きを減らす設定 |
| 実機 | 実顔有無、PC 切替・入力停止、カメラ拒否、ロック・スリープ復帰、表示倍率、実 API の品質 |

CI が通っても実カメラ・実 API・透過ウィンドウの確認が済んだことにはしない。結果を PR に分けて記録する。

## 7. データ・キー・資産

- 設定はアプリ内で行う。キーを `.env` やコードへ埋め込まず、Rust のキー保護アダプターで扱う。`.env*`、ローカルデータ、生成資産は土台整備時に `.gitignore` へ追加する。
- `node_modules/`、`dist/`、`src-tauri/target/`、生成 WASM、実行ログ、履歴・レポートファイルはコミットしない。モデル本体と生成コピーのどちらを管理するかを明示し、再現用スクリプトとライセンスを残す。
- fixtures とデモには架空のウィンドウタイトルを使う。アプリ識別子 `com.jphacks.sd2608` を維持し、試作版のユーザーデータをコピーしない。
- GIF・静止画像は出典と利用条件を記録する。画面サイズ・画像の表示基準点・再生時間・ループ可否を manifest で共有する。

## 8. 統合・デモの完了条件

各フェーズ終了時に統合し、基本デモでは途中にも「休憩通知まで」「レポートまで」の接続を確認する。最後の約20%は安定化と発表に充てる。

単体アプリの確認コマンド：

```powershell
npm run tauri build -- --debug --no-bundle
```

生成されたアプリを開発サーバーなしで起動し、短縮時間で「開始 → 提案 → No → 区切り再通知 → Yes → レポート即表示」を実演する。別シナリオで「離席確定 → 帰席 → 5秒後に旧セッションのレポート表示」と「No を続けて60秒で再通知」を確認する。

最終的に [受入条件 AC-01〜08](requirements.md#6-初期状態保存受入条件) を確認し、デモ用コミット、操作手順、モック使用箇所、予備録画を README に記載する。
