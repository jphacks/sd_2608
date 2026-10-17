# B-01 実装・検証メモ

以下は B-01 時点の記録。B-02 で PC 取得と runtime_start を接続した最新状況は [PC情報取得メモ](backend-pc-activity.md) を参照。

対象ブランチ：`feat/backend-runtime-contract`（分岐元：`develop/backend`）。[B担当の計画](backend-development-plan.md) の B-01 を実装した。カメラ・PC 取得・通知判定・保存・レポート生成は、引き続き後続作業とする。

## 1. 実装したもの

| 領域 | 主なファイル | 内容 |
|---|---|---|
| 通信 DTO | `src-tauri/src/ipc/dto.rs` | TypeScript と同じ camelCase、union、必須の null、ApiResult。整数は JS の安全な整数の範囲に制限 |
| 状態の正本 | `src-tauri/src/application/app_service.rs` | 初期 snapshot、runtimeId、revision、trackingId、実行世代、設定 revision、最大1,000件の重複受付記録 |
| 時計 | `src-tauri/src/ports/clock.rs` | UTC 日時と単調時計の経過を別に取得できるポート。テストで差し替え可能 |
| Tauri 登録・イベント | `src-tauri/src/ipc/{commands,events}.rs`、`lib.rs` | 10コマンドの登録、main ウィンドウ限定、更新後の `app://snapshot`、ページ再読み込み・終了時の停止入口 |
| フロントの検証 | `src/adapters/tauri/decode.ts` | 成功・失敗の両応答を unknown から検証。未知 enum、欠落、範囲外数値、不要なキー、不正な version を拒否 |
| 実接続 | `src/adapters/tauri/TauriGateway.ts` | 購読後の初期取得、イベントのバッファ、5秒再同期、画面復帰時取得、旧 revision・旧 runtime の破棄 |
| 環境への依存 | `src/adapters/tauri/{transport,nativeTransport}.ts` | invoke・listen・タイマー・復帰通知・requestId の生成を差し替え可能に分離 |
| 表示への接続 | `src/application/RuntimeApp.tsx`、`src/App.tsx` | Tauri 起動時に既存 Hook と AppView へ real Gateway を注入。A の表示コンポーネントは変更しない |

`AppGateway.connect` に任意の第2引数 `onConnectionError(error | null)` を追加した。ポーリングの失敗を表示し、同じ revision の正常応答でも接続状態を回復できる。既存の1引数のモックはそのまま利用できる。

AppController は、別 runtime の初期イベントを revision の数字だけで並べ替えないようにした。退役した runtime の遅いイベント・要求結果から、過去の状態が復活しない。

## 2. 現在のコマンドの動作

| コマンド | B-01 時点の結果 |
|---|---|
| `app_get_snapshot` | 停止中、取得オフ、unknown、設定初期値、空のジョブを返す。読取りで revision は増えない |
| `report_list` | 空の一覧。limit は1〜20。発行した cursor がまだないため、null 以外の cursor は validation |
| `report_get` | notFound |
| `runtime_stop` | 一致する trackingId の状態を停止し、世代を更新する入口。初期状態は trackingId が null なので任意の ID は staleTracking |
| `data_clear` | メモリー内の監視・ジョブ状態を消し、世代・revision を更新。設定は保持。保存機能がないためファイルには触れない |
| `runtime_start` | 設定 revision・同意・要求の形式を確認したうえで、未接続を示す invalidState。開始成功を返さない |
| `face_submit` | 要求を検証し、開始済み監視がないため staleTracking |
| `reminder_respond` | 要求を検証し、有効な通知がないため staleReminder |
| `settings_update` | 要求を検証し、保存未接続を示す invalidState。API キーは保存しない |
| `report_retry` | 要求を検証し、生成未接続を示す invalidState |

更新コマンドは requestId を照合し、同じ ID・内容なら受付結果を再利用する。違うコマンド・内容で同じ ID を使った場合は validation。キャッシュにはプロセス固有の照合子と結果だけを記録し、API キーを含む要求本文は保持しない。未接続として拒否した有効な要求も同じ規則で扱う。

## 3. 接続と解放

1. `app://snapshot` を購読してから初期 snapshot を取得する。
2. 取得中の同じ runtime のイベントは新しい revision を採用する。異なる runtime のイベントは正本を再取得して確認する。
3. 5秒ごとの取得と focus / visibilitychange でイベントの欠落を補う。取得が重なる場合は直列化する。
4. dispose で購読・ポーリング・復帰通知を解除する。listen の完了が遅くても、旧接続だけを解放する。
5. 接続解除後に開始結果が到着した場合は、その結果の trackingId を指定して停止する。新しい trackingId へ停止を転送しない。

requestId を付ける更新要求を自動再送する処理はまだ追加していない。ネットワーク・IPC 失敗時に、同意なしで開始や送信を再実行しない。

## 4. 起動と検証

Windows の実アプリを起動する：

```powershell
npm run tauri dev
```

Tauri 内では既存 AppView に接続済み・監視停止中・空のレポート一覧が渡る。開始・設定保存を選んだ場合は、それぞれ未接続のエラーが表示される。通常のブラウザー起動は Tauri 起動の案内、`npm run dev:mock` は従来の表示開発画面になる。

確認コマンド：

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm.cmd run tauri -- build --debug --no-bundle
```

- フロント：67件。共通 JSON 35ケース、Gateway の順序・再同期・解放・古い処理の破棄、既存モックと Controller を検証。
- Rust：単体12件＋IPC 統合1件。共通 JSON の往復・拒否、初期状態、要求の一意性、並行呼出し、世代、認可、全10コマンドの登録と欠落した request の拒否を検証。
- `src-tauri/tests/runtime_ipc.rs` は Tauri の MockRuntime を使うフレームワーク統合テスト。実 WebView の目視・実センサー検証を代替するものではない。
- Windows のテスト実行には Common Controls v6 の manifest が必要なため、`tests/windows.manifest` を統合テストだけにリンクする。通常アプリの manifest は引き続き tauri-build が扱う。
- 単体アプリの出力先は `src-tauri/target/debug/sd_2608.exe`。ビルドの成功と、実画面の目視確認は区別して扱う。

## 5. 次の作業

B-02 では `ActivitySource` と Windows の取得処理を追加する。B-01 の AppService と停止・世代の仕組みに接続し、取得データの正本を増やす。FaceInput は B-03、在席・通知の判定は B-04 で接続する。

未実装コマンドの拒否を外す際は、そのコマンドの処理、開始停止のテスト、Wire DTO、MockGateway との差分を同じ機能ブランチで更新する。A の Props を変更する場合は先に共有し、モックも同時に追従させる。
