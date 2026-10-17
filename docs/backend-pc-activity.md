# B-02：PC 操作情報の取得

対象：`feat/backend-pc-activity`。B-01 を `develop/backend` に取り込んだ `48d7529` から分岐した。[B担当の計画](backend-development-plan.md) の B-02 に対応する。

## 実装した範囲

| 層 | ファイル | 責務 |
|---|---|---|
| 入力ポート | `src-tauri/src/ports/activity.rs` | ActivitySource、入力停止時間、前面ウィンドウの分類、内部サンプル |
| Windows | `src-tauri/src/infrastructure/windows/activity.rs` | GetLastInputInfo、前面 HWND・PID・実行ファイル名・タイトル、保護画面の確認 |
| 取得ループ | `src-tauri/src/application/activity_monitor.rs` | 約1秒間隔の単一ワーカー、開始・停止・再開、世代の照合 |
| 状態と通信 | `src-tauri/src/application/app_service.rs`、`ipc/commands.rs` | 同意後の開始、trackingId、現在の入力、状態イベント、停止時の消去 |
| 実機確認 | `src-tauri/examples/activity_probe.rs` | 秒数を制限した診断。タイトル・アプリ名・HWND・PID は出力しない |

試作版 `break-support-pet/src-tauri/src/activity/{mod,windows,monitor}.rs` を参考に移植した。LocalStore への依存を外し、取得元を注入できるようにした。Windows 依存は既存 lock 内の `windows 0.62.2` に必要な機能だけ追加し、HTTP・画像取得等は導入していない。

## 現在の開始・停止

- 起動時は取得オフ。ローカルモードで同意して「開始」を押すと、PC 情報の取得だけが動く。`runtime.phase=running`、`camera=off`、`presence=unknown` と、未接続機能の説明を返す。
- 顔検出、連続在席・区切り・通知判定、履歴保存、レポート生成は後続の B-03〜07。入力停止だけで離席や休憩を確定せず、通知・ジョブを生成しない。AI モードの開始は `providerNotConfigured`。
- 同じ requestId・内容の再送は同じ受付結果を返す。別要求で実行中に再開始すると `invalidState`。再開には停止を挟む。
- Stop・data_clear・再読み込み・メインウィンドウの終了で取得を無効化し、現在の PC 情報とイベント送信先を消す。古い trackingId の Stop は新しい取得を止めない。
- ワーカーは再開時にも再利用する。OS 呼び出しを状態ロック外で行い、停止ではその終了を待たない。遅い結果はワーカー側と AppService 側で世代を照合して捨てる。破棄後に戻った取得結果も採用しない。

## 分類と情報の扱い

| 分類 | 意味・扱い |
|---|---|
| external | 外部アプリ。現在の1サンプルにだけウィンドウ情報を保持 |
| pet | 自プロセス。タイトルの取得前に除外。作業や区切りの根拠として扱わない |
| excluded | 認証プロセス、タスクバー・デスクトップ、設定の除外アプリ。タイトルの取得前に除外 |
| restricted | 通常の入力デスクトップではない、または安全を確認できない |
| unavailable | 前面 HWND・PID・プロセス情報・ウィンドウの同一性を確認できない |

除外名は実行ファイル名との大文字・小文字を区別しない完全一致。設定の保存・編集は B-05 なので、現段階のユーザー設定は初期値の空一覧。ポートと AppService では除外一覧の適用をテスト済み。

分類が変わるたびに前のサンプルを置き換える。pet・除外・保護・取得不可の入力へ、前回の external のタイトルを引き継がない。タイトル等は通常の AppSnapshot に追加せず、内部型は Serialize を実装しない。Debug でもウィンドウ情報を伏せる。スクリーンショット・キーの内容は取得しない。

GetLastInputInfo の32bit時刻は周回を考慮し、未来・半周以上の曖昧な差を `None` にする。取得に5秒超を要したサンプルは不採用。内部の `latest_activity()` も単調時計で5秒超の入力を破棄する。部分的な取得不可は `activity=error` と unknown、保護画面は unknown / protectedScreen とする。次の正常サンプルで回復する。

## 確認方法と結果

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm.cmd run tauri -- build --debug --no-bundle
```

- フロント67件、Rust単体20件＋Tauri IPC統合1件。契約の初期 fixture は変更していない。
- OS を呼ばないテストで、二重開始、取得中の停止・再開・破棄、旧世代の結果、読み取りエラーと回復、古いサンプル、tick 周回、除外、情報消去、同意、旧 trackingId、IPC の開始・停止を検証する。
- 実 Windows の診断で `external`、入力停止時間の約1秒ずつの増加、実入力後のリセットを確認した。制限環境では前面情報が `unavailable`、通常セッションでは `external` になり、タイトルを出さずに動作した。
- 実アプリの目視、別アプリへの切替、ペット自身へのフォーカス、ロック・認証画面の実機確認は未実施。これらの分類と消去は単体テスト・コード確認の範囲であり、実機確認済みとは扱わない。

診断は明示的に実行した間だけ取得する。第1引数は1〜60秒で、省略時は10秒。

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --locked --example activity_probe -- 15
```

診断中に外部アプリ間を切り替え、`window_changed=true` を確認する。入力を止めると idle_ms が増え、入力すると戻る。ロック中は restricted または unavailable とし、旧ウィンドウ情報を保持しない。診断の `pet` は診断プロセス自身を意味するため、本体へのフォーカスは本体の Rust デバッガーで分類を確認する。

## B-03・B-04への引き継ぎ

IPC のコマンド・TS の共通型・A の Props は変更していない。B-03 は開始結果の trackingId に顔検出を接続し、現在の未接続案内と camera 状態を更新する。B-04 は新しい ActivitySample を同じ状態ロック下で Domain へ渡す。外部ウィンドウ以外の分類と入力の鮮度を確認してから、在席・区切り・通知を評価する。履歴の保持やマスクは B-05 の責務とする。
