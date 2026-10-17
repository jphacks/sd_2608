# B担当：機能実装の詳細計画

作成日：2026-10-17。B担当の実装を、個別に検証して統合できる単位に分ける。元の phase の番号には拘束されず、**実データを既存の UI 契約へ接続し、通知とレポートの両経路を完成させる順序**で進める。

機能の条件は [機能仕様](requirements.md)、責務は [アーキテクチャ](architecture.md)、通信は [API 設計](api-design.md) に従う。本書は実装順序と作業範囲を具体化するもので、機能仕様を変更するものではない。

## 1. 開始地点と今回の成果物

- PR #3 はマージ済み。開始地点は `origin/main` の `2b8828b9fee7ff1d56848d46c6c3a225e19445f0`。
- 共通型、AppGateway、AppController、React Hook、15種類のモック、UI のひな型、18件のフロントテストは存在する。
- 計画開始時の Rust は `greet` のみ。実 Gateway、カメラ、PC 取得、Domain、保存、予約、AI 通信は未実装だった。
- B-01 の共通 DTO・実 IPC・Gateway・初期画面の接続を実装し、develop/backend へ取り込み済み。[B-01 メモ](backend-runtime-contract.md) を参照。
- B-02 の PC 情報取得と開始・停止を実装した。[B-02 メモ](backend-pc-activity.md) に範囲と検証結果を記載。顔検出・判定・保存・レポートは B-03〜09 の後続作業。

B担当の完成目標は、実 Windows アプリで次の操作が通ること。

1. 明示的な開始で顔・PC 情報を取得し、連続在席を計測する。
2. 約30分から区切りを見て休憩を提案し、No 後は延期・区切り再通知、60分で区切りを待たず再通知する。
3. Yes で即時、自然離席の確定から5分後にレポートを生成する。帰席しても予約は維持し、完成後すぐ表示する。
4. 停止・終了・再読み込みで取得と未実行予約を止め、設定と保存済みカードを適切に扱う。

## 2. ブランチ運用

### ブランチの役割

| 種類 | 名前 | 分岐元・取り込み先 |
|---|---|---|
| 全体の統合先 | `main` | A・B の共有契約と完成した変更を集める |
| B専用の統合先 | **`develop/backend`** | 上記の main から作成。B の機能ブランチを集める |
| 今回の計画書 | `docs/backend-development-plan` | develop/backend から分岐。文書確認後に同ブランチへ取り込む |
| 個別の機能 | 後述の `feat/backend-*` など | 毎回、最新の develop/backend から分岐し、同ブランチへ取り込む |

Git のブランチは物理的に入れ子になるものではない。**分岐元と PR の base を develop/backend にそろえる**ことで、希望する「B用ブランチの中で機能ごとに作業する」運用にする。B の途中機能を直接 main へ向けた PR にしない。

計画文書は計画用ブランチでコミットし、ローカルの develop/backend へ反映済み。機能実装は各機能ブランチで行う。リモートで共有・PR を始める時点で develop/backend を push する。

### 機能ごとの作業手順

以下は **今後の実装時に使う例**。リモートの develop/backend を作成した後の手順とする。

```powershell
git fetch origin
git switch develop/backend
git merge --ff-only origin/develop/backend
git switch -c feat/backend-runtime-contract
```

実装・検証後は機能ブランチを push し、**base: develop/backend、head: 作業ブランチ**で PR を作る。レビューと検証が済んだ変更を統合し、次の機能は更新後の develop/backend から新しく分岐する。前の機能ブランチから連続して分岐しない。

- ローカルだけで取り込む場合も、同じチェックを通してから `git merge --no-ff 作業ブランチ名` を使い、機能の境界を履歴に残す。
- A の共有契約・UI 更新が main に入ったら、作業を区切って main を develop/backend へマージする。共有済みの B 統合ブランチを rebase・force push しない。
- 進行中の機能には、更新した develop/backend をマージして追従する。競合時に A の変更を一括上書きしない。
- B の milestone ごとに develop/backend → main の PR を作れる。未接続の機能を利用可能に見せず、少なくとも「実データで休憩通知」「ローカルレポートの両経路」「AI と保存」の動く区切りで共有する。
- 計画作成だけの今回、新しい PR は作成しない。PR を作成する際は、その時点の依頼・合意に従う。

## 3. B の責務と契約

| 領域 | 主な配置案 | 方針 |
|---|---|---|
| Rust の組み立て・IPC | `src-tauri/src/lib.rs`、`ipc/{commands,dto,events}.rs` | 既存10コマンドと ApiResult を実装。main ウィンドウだけを許可 |
| 実行制御 | `src-tauri/src/application/` | AppService、監視の世代、直列化、レポート調整、イベント配信 |
| 純粋な判定 | `src-tauri/src/domain/` | presence、session、boundary、reminder、history、report、timings、event |
| 差し替え可能な入出力 | `src-tauri/src/ports/` | Clock、ActivitySource、ReportProvider、Repository、SecretStore |
| OS・保存・外部通信 | `src-tauri/src/infrastructure/` | Windows API、ロック・復帰検知、JSON、キー保護、HTTP |
| フロントの実接続 | `src/adapters/tauri/`、`src/adapters/camera/` | IPC Transport、実行時の応答検証、TauriGateway、顔検出 |
| アプリへの接続 | `src/App.tsx`、`src/application/` | real Gateway を既存 Controller・AppView に注入 |

`AppViewProps` と `AppGateway` は既存のものを維持する。A が担当する `components/`、`styles/`、`presentation/`、`public/pet/` は原則変更しない。Tauri のサイズ・透過・ドラッグ・終了は B が接続し、必要な画面上の操作を A と合わせる。

通知・在席・レポートの正規状態は Rust に1つだけ置く。MockGateway の TypeScript の判定を本番処理へ転用しない。姿勢判定・画面の見すぎ・日次記録のコードは今回追加しない。

## 4. 実装順序と依存関係

| ID | 機能ブランチ | 前提 | 目に見える到達点 |
|---|---|---|---|
| B-01 | `feat/backend-runtime-contract` | 現在の共通基盤 | 実 IPC で停止中の状態・空の一覧を表示できる |
| B-02 | `feat/backend-pc-activity` | B-01 | 実 PC の入力停止・外部ウィンドウを安全に取得・停止できる |
| B-03 | `feat/backend-face-detection` | B-01、統合時は B-02 | 実カメラの顔有無を Rust へ渡し、開始・停止できる |
| B-04 | `feat/backend-presence-reminder` | B-01〜03 | 実データから在席・区切り・Yes／No 通知が動く |
| B-05 | `feat/backend-history-storage` | B-04 | セッション履歴の固定・設定保存・カード保存の基盤ができる |
| B-06 | `feat/backend-report-scheduler` | B-04、05 | Yes／離席5分後のローカルカードが完成・即表示される |
| B-07 | `feat/backend-ai-provider` | B-05、06 | 同意した AI で要約でき、失敗・再試行も扱える |
| B-08 | `fix/backend-lifecycle-recovery` | B-01〜07 | ロック・スリープ・再接続・停止競合を通し確認できる |
| B-09 | `test/backend-integration` | B-08、A の表示 | デモ用単体アプリと確認記録がそろう |

B-04 の純粋な判定テストは B-01 の後から実センサーなしでも書けるが、統合は上記の順序にそろえる。各行を1つの巨大 PR にせず、必要なら `-dto`、`-gateway` などに分割する。分割した場合も base は develop/backend とする。

### B-01：実行基盤と IPC 契約

**対象**：`ipc/`、`application/app_service.rs`、`ports/clock.rs`、`src/adapters/tauri/`、`src/App.tsx`。原則、新規外部依存を増やさずに始める。

1. TypeScript の DTO を Rust に対応付け、日時・ID・null・union・camelCase・ApiResult の JSON をそろえる。安全な整数の上限も検証する。
2. AppService に runtimeId、revision、trackingId、実行世代、設定 revision、操作の重複受付記録を置く。停止中の初期値を共通 fixture と照合する。
3. 10コマンドを登録する。最初は `app_get_snapshot`、空の `report_list`、`report_get` の notFound、停止・削除の入口から実装する。未接続の開始・生成・保存を成功として返さず、明示的なエラーにする。
4. TauriGateway と Transport を分ける。応答を unknown として検証し、バージョン違い・不正な enum・数値・必須項目の欠落を拒否する。
5. イベント購読 → snapshot 取得 → バッファ適用の順で接続する。5秒ごとの再同期、画面復帰時の取得、旧 revision・旧接続の破棄を実装する。
6. `src/App.tsx` に real Gateway の組み立てを追加し、既存 AppView と Hook へ渡す。ブラウザー通常起動では Tauri 未接続の案内を維持し、dev:mock はそのまま使えるようにする。

**検証・完了条件**：Rust のシリアライズ結果と TS の decoder を同じ JSON ケースで検証する。実アプリに停止中の状態と空一覧が出る。接続失敗を表示でき、React StrictMode の再接続で購読・タイマーが増えない。未接続処理は明示的に拒否する。

### B-02：PC 操作情報の取得

**対象**：`ports/activity.rs`、`infrastructure/windows/activity.rs`、監視サービス。Windows 依存と Cargo.lock の変更もこの作業で行う。

1. 試作版の `activity/windows.rs` と `activity/mod.rs` を参考に、入力停止・前面ウィンドウ・プロセス情報を取得する。
2. `external / pet / excluded / restricted / unavailable` を区別する。ペットの操作を作業や区切りに数えず、ロック画面・認証プロセス・除外アプリは対象から外す。
3. 約1秒の取得を単一ワーカーで行い、二重開始を防ぐ。Stop 後の遅い取得結果は世代の照合で破棄する。
4. 取得元を ActivitySource ポートで差し替え可能にし、OS を呼ばない単体テストを用意する。生のウィンドウタイトルを UI の通常 snapshot・ログへ流さない。

**検証・完了条件**：別アプリへの切替、入力停止時間の増加・リセット、ペット自身、取得不可を実機で確認する。開始停止の競合、タイマー値の周回・不確かな値、停止後の情報消去をテストする。この時点では入力停止だけで離席・休憩と判定しない。

### B-03：顔検出と入力の橋渡し

**対象**：`src/adapters/camera/`、TauriGateway、`face_submit`、顔モデル資産準備と npm 定義・lock。

1. 試作版の FaceDetectionController をアダプターとして移植する。MediaPipe のモデル・対応 WASM・ライセンスを同梱し、実行時の CDN 取得を不要にする。OCR 関連資産は移植しない。
2. Gateway の start で Rust の開始を受け付けた後、同じ trackingId に対してカメラを開始する。顔結果がそろうまでは waiting / unknown とする。
3. 約1秒ごとに FaceInput を1件ずつ送る。trackingId、sequence、取得時刻、source を検証する。再送を重複評価せず、古い監視の入力を拒否する。
4. 権限拒否・カメラ切断・フレーム更新停止は unavailable として通知する。起動途中の Stop、再読み込み、dispose でも stream・Detector・送信ループを解放する。
5. demo 限定で手動の顔入力を差し込めるポートを用意する。本番の実カメラ結果とは source と表示で区別する。

**検証・完了条件**：実カメラで顔を出す／隠すと Rust の入力が変わる。映像・座標は保存・送信しない。起動直後の停止、権限拒否、旧 trackingId・同一 sequence・古い時刻をテストし、開始し直しても古いカメラが残らない。

### B-04：在席・区切り・休憩通知

**対象**：`domain/{presence,session,boundary,reminder,timings,event}.rs` と AppService。Domain は Tauri・Windows・HTTP に依存させない。

1. Clock を注入し、内部の経過時間と UTC の保存日時を分ける。通常・demo のしきい値を1か所に集める。ブラウザー時刻をそのまま連続計測の時計にしない。
2. PresencePolicy：異なる顔サンプル5回中3回＋最新ありで present。顔なし・入力停止の両方が通常30秒で away。一時欠落は uncertain、更新停止・保護画面は unknown にする。
3. SittingSession：安定在席で開始し、短い顔欠落を維持する。確定離席では顔なし開始時刻で閉じ、観測不能や顔なしのまま入力が続く中断は離席予約と区別する。
4. BoundaryPolicy：入力停止5秒、またはウィンドウ切替後10秒以内の入力停止2秒で、ID 付きの新しい区切りを1回だけ発行する。
5. ReminderPolicy：30分から区切りを待ち、35分で最初の提案。No は2分の抑制後に新しい区切り、または10分上限で再提案。60分で延期を打ち切り、以降の No は5分間隔とする。
6. Yes 後も起立を断定せず在席時間を保持する。通常10分の猶予と、未通過の60分到達を仕様どおり扱う。uncertain / away / unknown では通知を隠す。
7. 回答には表示中の reminderId と sessionId を要求する。通知を毎秒作り直さず、同じ通常通知を60分で強調へ更新する。
8. Yes のレポート要求を Domain イベントとして発行する。B-06 接続前は「作成済み」を返さず、開発中の未接続状態を明示する。

**検証・完了条件**：AC-01〜03 と通知に関わる AC-06 を注入時計で検証する。境界の直前・同時刻・直後、59分の No、60分を超えてからの Yes／No、短い顔欠落、更新停止、古い通知への回答を含める。実機の短縮時間でも休憩通知まで通る。

### B-05：履歴・設定・保存の基盤

**対象**：`domain/history.rs`、Repository / SecretStore のポート、`infrastructure/storage/`、`settings_update`、`report_list / get`、`data_clear`。

1. 有効な作業セッションに対し、同じ外部ウィンドウ・タイトルの連続区間をまとめる。直近30分・最大600区間とし、対象範囲の端を切り詰める。
2. 試作版 `summary/privacy.rs` のマスク・除外を移植する。生タイトルは処理中だけ保持し、マスク後の区間を履歴バッファへ入れる。
3. 履歴固定を提供する。対象はセッション ID と終了時刻で指定し、取得後の作業や別セッションを混ぜない。参照ではなく独立したコピーを返す。
4. settings.json / reports.json を schemaVersion 付きで読み書きする。一時ファイルから置き換え、破損・未知バージョンを検出したら元データを保全して停止状態で案内する。
5. 設定変更は停止中と revision 一致を条件にする。API キーは SecretStore へ渡し、DPAPI で保護する。通常 JSON・snapshot・ログへキー本文を入れない。
6. カードは最新20件かつ7日以内を保持する。監視中フラグ・顔入力・未実行予約は再起動で復元しない。data_clear は停止と実行世代の更新を先に行う。

**検証・完了条件**：マスク・区間化・範囲切り詰め・上限・除外のテスト、JSON 往復、保存失敗、破損、設定競合、キー変更を確認する。テストは専用一時ディレクトリとダミーキーを使い、普段のユーザーデータを読まない。実機で再起動後に設定・保存カードだけを復元できる。

### B-06：レポート調整と5分予約

**対象**：`domain/report.rs`、`application/report_coordinator.rs`、ワーカー・scheduler、`reminder_respond`、`report_retry`。まず外部 API のないローカルカードで両経路を完成させる。

1. 有効な Yes の受付、履歴固定、sessionId ごとの一意なジョブ登録を同じ状態更新で確定する。二重クリック・離席との競合でジョブを増やさない。
2. 確定離席では顔なし開始までの履歴を固定し、**離席の確定時刻＋5分**を期限にする。帰席を取消条件にせず、新旧セッションの予約を別々に保持する。
3. queued / running / ready / failed / cancelled を管理する。実行中は1件、未開始の即時要求を優先、予約同士は期限・作成順とする。状態ロックを通信・保存待ちの間に保持しない。
4. ローカルカードを作成し、カードの参照先を確定してから completionSeq と snapshot を更新する。保存失敗は storageFailure として明示し、保存成功を装わない。
5. AppController の表示キューへ完成を接続する。帰席待ちを入れず、同じ sessionId の再要求は既存ジョブ／カードを返す。
6. 停止・削除で未実行予約を取り消す。古い実行世代・試行番号の完了は破棄する。failed の明示的再試行だけ同じ ID・履歴で attempt を増やす。

**検証・完了条件**：AC-04、05 とジョブに関わる AC-06 を検証する。Yes 直後の離席、同時要求、帰席後の期限到達、旧予約と新セッションの同時進行、複数完成、削除と完了の競合を含める。短縮デモで Yes と自然離席の両方からカードが即表示される。

### B-07：AI Provider と失敗時の扱い

**対象**：`ports/report_provider.rs`、`infrastructure/providers/`、設定・同意の検証、レポートワーカー。

1. 試作版の Gemini / OpenAI 互換処理を、共通の ReportProvider へ分離して移植する。形式ごとの endpoint の意味を API 設計にそろえる。
2. 開始時に設定 revision・キーの有無・送信同意を検証し、ジョブに設定と同意の識別情報を固定する。未同意・未設定なら明示したローカルモードを利用する。
3. マスク済みの固定履歴だけを送信する。履歴が空なら通信しない。タイトル中の命令文を実行指示として扱わず、観測データとして区切る。
4. タイムアウト60秒、リダイレクトなし、自動再試行なし、同時実行1件を適用する。JSON の形式と文字数・件数・応答サイズを検証する。
5. 認証・通信・不正応答を失敗カードへ変換する。生レスポンスやキーを表示しない。再試行時は元の固定履歴と現在の同意を使い、送信先変更があれば確認を取り直す。

**検証・完了条件**：AC-08。ローカルの検証用 API で両形式、401、429、500、タイムアウト、不正 JSON、過大応答、キャンセルを確認する。実サービスはデモ用の架空履歴で別途確認し、モック・検証用 API の結果と区別して記録する。

### B-08：停止・ロック・スリープ・再接続の統合

**対象**：実行制御、Windows の状態検知、Clock / scheduler、TauriGateway、Controller。基本的な停止は各機能で実装済みとし、ここでは複数機能をまたぐ競合を確認する。

1. ロック・保護画面・観測更新の長い途切れではセッションを中断し、休憩通知と自動の離席予約を新規発行しない。
2. スリープ中は在席を加算しない。起動したまま復帰した場合、既存予約は期限を確認して1回だけ実行する。単調時計と壁時計を Clock 内で扱い、OS の復帰通知と手動の時計変更を区別する。
3. 監視 Stop は状態を先に無効化し、PC ワーカー・カメラ・予約・通信を停止する。途中の停止失敗を表示し、再停止できるようにする。
4. ページ再読み込み・ウィンドウ終了は Rust 側でも検出し、フロントの cleanup だけに依存しない。StrictMode の古い dispose が新しい trackingId を停止しないようにする。
5. runtimeId が変わる再接続では古い応答・表示キューを破棄する。初回接続時の過去カード再表示は手動、新しい完成は自動という境界を検証する。

**検証・完了条件**：AC-06 を実 Windows で確認する。開始途中の停止、連打、通信中の終了・削除、ロック復帰、スリープ復帰、手動時刻変更、WebView 再読み込みの操作と結果を記録する。

### B-09：A の表示との統合とデモ

**対象**：App の組み立て、WindowAdapter、Tauri 設定・権限、確認記録と README。

1. A の最新表示を main 経由で統合する。AppView の内部を B 側で作り直さず、Props・action・GIF のきっかけを合わせる。
2. 透過・最前面・ドラッグ・終了・ウィンドウ配置を接続する。現在の画面全体のサイズを固定観念で小さくせず、吹き出しとカードが収まるサイズ・表示領域を A と確認する。
3. short demo と通常値の注入時計テストを通す。実 API の有無、手動入力か実カメラかをデモ手順に明記する。
4. 開発サーバーなしで単体アプリを起動し、初期オフ・終了・再起動・再表示を含む AC-01〜08 の確認記録をそろえる。

**完了条件**：両機能が実機でつながり、デモ用コミットとビルドを固定できる。実 API なしの代替デモ・操作手順も用意する。GIF 自体の制作・見た目の調整は A の責任範囲とする。

## 5. 検証と統合の共通条件

機能ブランチごとに、変更に関係するテストと以下を実行する。カメラ・実 API を毎回要求せず、実機検証が必要な変更は操作・結果を別記する。

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

- Rust の JSON と TS decoder は共通の JSON ケースを `tests/fixtures/ipc/` に置いて照合する。正常例に加え、null、未知の値、上限外の整数、古いバージョン、不正な失敗応答を含める。
- Domain・scheduler は注入時計、外部入出力は fake のポートで検証する。実時間の30分・60分を単体テストで待たない。
- 既存18件のテストは UI 用モックとコントローラーの検証であり、本番 Rust の判定・予約が正しいことの代わりにはしない。
- PR には目的、実装した B-ID、変更した IPC、テスト結果、実機結果、残作業を記載する。共通型の変更は decoder・Rust DTO・fixtures・設計書まで同じ変更でそろえる。
- 未完成の分岐では、その機能を明示的に未接続とする。実処理が失敗したときに無表示でモックへ切り替えない。

## 6. 移植と依存追加の扱い

移植元は `break-support-pet` の `9ff7cf0d3c6b72a382d64a196556ae757de0c99f`。移植するモジュールと関連テストを機能ごとに記録する。

| 再利用候補 | 再設計が必要な点 |
|---|---|
| `src/features/camera/faceDetector.ts` | 新しい FaceInput・trackingId・sequence と Gateway の寿命へ接続 |
| `src-tauri/src/activity/` | LocalStore への直接依存を外し、ActivitySource と AppService に接続 |
| TS の在席・休憩ルール | 新仕様の Rust Domain へ移す。No 後の区切り再通知と60分上限を追加 |
| `src-tauri/src/summary/privacy.rs`、`secrets.rs` | 新しい履歴・Repository・SecretStore へ分離 |
| `src-tauri/src/summary/provider.rs`、`automatic.rs` | Provider と Coordinator を分離。Yes の送信前プレビューを今回の即時作成へ変更 |

依存は必要になった機能ブランチで追加し、定義ファイルと lock を同時に更新する。Windows API・MediaPipe・HTTP・マスク処理などは試作版で使うものを出発点とし、無関係な最新版への一括更新や OCR の導入はしない。

## 7. B の milestone と直近の着手点

| milestone | 完成すること | main への共有の目安 |
|---|---|---|
| M1：実データで通知 | B-01〜04 | 実カメラ・PC 情報から短縮時間の Yes／No 通知が出る |
| M2：ローカルのレポート | B-05〜06 | Yes と離席後の両経路で、帰席条件なしに履歴カードが表示される |
| M3：AI・停止・実機統合 | B-07〜09 | AI 要約、失敗、保存、停止・復帰、A の表示まで通る |

直近の次の作業は **B-03：`feat/backend-face-detection`**。B-02 を develop/backend へ取り込んだ後、その最新地点から分岐する。B-02 の範囲・実機確認の残りは [実装・検証メモ](backend-pc-activity.md) を参照。

残り時間が厳しい場合も、顔・PC 情報・通知・Yes／自然離席のローカルカード・停止を優先する。AI の接続先を増やす、姿勢や日次記録へ着手する、といった拡張より、両経路を実演できる状態を先に確保する。
