# B-05：履歴・設定・保存の基盤

対象：`feat/backend-history-storage`。B-04 を `develop/backend` にマージした `1067110` から分岐。[B担当の計画](backend-development-plan.md) の B-05 に対応する。通信 DTO・A の Props は変更していない。

## 実装した範囲

| ファイル | 責務 |
|---|---|
| `src-tauri/src/domain/history.rs` | マスク済み入力の区間化、30分・600区間の制限、独立コピーの取得 |
| `application/privacy.rs` | 試作版の URL・メール・ユーザー名・認証情報マスク |
| `application/app_service/history.rs` | PC 入力のマスク、セッションイベントとの接続、Wire 型への変換 |
| `application/persistence.rs` | 設定の検証・revision、カードの保持・一覧・取得・削除 |
| `ports/storage.rs` | Repository / SecretStore と保存文書の契約 |
| `infrastructure/storage/` | JSON の読み書き、Windows のファイル置換、DPAPI キー保存 |
| `lib.rs` | Tauri setup で保存先を解決。テスト用のインメモリー構成とは分離 |
| `examples/storage_probe.rs` | 専用一時ディレクトリでの別プロセス復元・削除診断 |

`settings_update`、`report_list / get`、`data_clear` を実保存へ接続した。B-05 自体はカードを自動生成しない。カード保存の入口 `Persistence::save_report` を用意し、診断では架空のローカルカードを保存して参照経路を検証する。

## 履歴の扱い

- 監視開始だけでは記録せず、Domain の有効なセッション開始から記録する。生タイトルは現在の PC 入力だけに置き、履歴へ入れる前にアプリ名・タイトルをマスクする。
- 同じ PID・ウィンドウ・原タイトルの連続区間だけを結合する。原タイトルの一致確認にはプロセス内のランダム化した指紋を使い、原文をバッファへ残さない。マスク後に同じ文字列になっても別タイトルは分ける。
- pet・除外アプリは記録せず、欠測・取得不能・保護画面をまたいで結合しない。同じ PC サンプルの再評価で時間を増やさない。サンプル間隔が5秒を超えた区間は埋めない。
- 現在セッションの直近30分、最大600区間を保持する。終了時刻をさかのぼって切り詰め、固定コピーへ別セッション・終了後の作業を混ぜない。表示時刻はセッション開始 UTC と単調時計から組み立てる。
- 顔欠落開始時点で固定コピーを一つ仮保持する。離席の確定待ち中にも通常バッファは進むため、このコピーにより離席直前の30分を保つ。顔が戻る・中断する・新セッションになると仮保持を破棄する。
- 有効な Yes または自然離席の `ReportRequested` で履歴を固定する。現段階では最後の要求コピーを一つだけ保持し、ジョブの登録成功や reportId は返さない。B-06 でセッションごとのジョブへ引き渡す。
- 停止・削除で通常バッファ、仮保持、未保存コピーを破棄する。再起動では復元しない。

マスクは既知のパターンを置換する処理であり、あらゆる機密文字列を識別するものではない。除外アプリの設定も併用する。レポート生成・外部送信は B-06／07 の後続作業。

## 保存形式と失敗時の動作

保存先は `app.path().app_local_data_dir()` で解決する `com.jphacks.sd2608` 専用ディレクトリ。プロトタイプの保存先は使わない。

| 保存物 | 形式・寿命 |
|---|---|
| `settings.json` | `{ schemaVersion: 1, revision, values: SettingsInput, secretId: Id \| null }` |
| `secrets/<ID>.bin` | 現在の Windows ユーザーに結び付けた DPAPI 暗号文。通常 JSON には参照 ID だけ |
| `reports.json` | `{ schemaVersion: 1, reports: Report[] }`。最新20件かつ作成から7日以内 |

JSON・暗号文は同じ保存先内の一意な一時ファイルへ書き、`sync_all` 後に Windows の `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` で置き換える。JSON の読込は16 MiBまでとし、schema・必須フィールド・設定・レポートの区間順序やセッション ID を検証する。

設定変更は停止中・設定 revision 一致が条件。同じ requestId・同じ内容の再送は二重保存しない。キーは新しい名前で暗号化保存してから設定の参照を切り替える。JSON 保存失敗時は新しいキーを片付け、旧設定・旧キー・revision を維持する。成功後に旧キーを削除する。処理途中でプロセスが終了した場合、参照されない暗号文が残る可能性はあるが、平文キーや未確定の設定を採用しない。

Provider の形式・接続先を変えたとき、Keep で旧キーを引き継がない。model の変更だけなら維持する。キーの読み出しに失敗した場合は `hasApiKey:false` と保存警告を返し、停止状態から設定し直せる。API キー本文は snapshot・一覧・エラー・ログへ含めない。

カードは起動時・保存時・参照時に保持期限を確認する。`report_list` は新しい順で本文を含めず、`report_get` は保存済み本文を返す。cursor は実行プロセスと一覧の世代に結び付き、保存・更新・期限整理・削除・再起動で無効になる。同じ ID のカード更新でセッション・固定履歴・作成時刻を変えることは拒否する。

破損・未知 schema・保存先の読み書き失敗は `storageFailure`。破損した原本を既定値で上書きせず、監視停止と警告を維持する。破損ファイルには `data_clear` でも上書きせず失敗を返すため、アプリを終了し、原本を別の場所へ保全・移動してから再起動する。キーの復号失敗だけなら設定画面から Replace / Remove で復旧できる。

`data_clear` は監視停止・実行世代の更新を先に行い、メモリー履歴・ジョブと保存カードを消す。設定とキーは保持する。保存失敗でも停止を取り消さず、削除成功を装わない。再起動時は設定と保存カードだけを復元し、同意、顔・PC 入力、セッション、予約、completionSeq は初期状態にする。過去カードを勝手に新着表示しない。

## 検証

2026-10-17、Windows 上で次を確認した。保存テストと診断は専用一時ディレクトリ・ダミーキー・架空カードのみを使い、普段のユーザーデータを読み書きしていない。

- Rust：69単体テスト＋登録済み IPC テスト1件。履歴の結合・上限・切詰め・固定後の独立性、離席直前30分の維持、設定競合、キー変更、保存失敗、破損・未知 schema、カード期限・ページング・削除を確認。
- Windows DPAPI：ダミーキーの暗号化・復号、暗号文中に平文がないこと、パス外参照拒否、削除を確認。
- Windows ファイル置換：設定ファイルを共有不可で開き、置換失敗時も旧 JSON・旧キーが残り、新キーが片付くことを確認。
- フロント：既存の82テスト、TypeScript 検査と Vite build が成功。共通 JSON 契約を維持。
- 別プロセス診断：保存 → プロセス終了 → 復元 → 削除 → 再復元を実行。設定・キーを維持し、カードだけ消え、全段階でセンサー・同意・ジョブが停止していることを確認。
- `cargo fmt --check` と Tauri の debug build（no-bundle）を確認。実 WebView で設定画面を操作して再起動する目視確認は未実施。

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo run --manifest-path src-tauri/Cargo.toml --locked --example storage_probe
npm.cmd run tauri -- build --debug --no-bundle
```

この実行環境のサンドボックス内では Windows ネイティブ保存操作が失敗したため、保存テスト・診断は通常の Windows 権限でも実行して成功を確認した。テストをスキップして成功扱いにはしていない。

## B-06 への接続点

`ReportRequested` の履歴固定をセッションごとの一意なジョブへ接続し、Yes の即時作成と離席確定＋5分予約を実装する。B-05 の設定保存は停止中に直列化し、カード保存は単独の Persistence メソッドとして分離した。B-06 では保存先へのアクセスを生成ワーカーへ接続し、状態ロックを保存・通信待ちの間に保持しない構成へ進める。実行世代・試行番号の確認と、カード保存確定後の completionSeq 更新も B-06 の担当範囲とする。
