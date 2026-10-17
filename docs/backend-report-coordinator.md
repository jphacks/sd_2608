# B-06：ローカルレポート・5分予約

対象：`feat/backend-report-coordinator`。B-05 を `develop/backend` にマージした `fdf8aad` から分岐。[B担当の計画](backend-development-plan.md) の B-06、[機能仕様](requirements.md) の AC-04・05 とジョブに関わる AC-06 に対応する。

## 実装した範囲

| ファイル | 責務 |
|---|---|
| `src-tauri/src/domain/report.rs` | セッションごとの一意性、期限、優先順、試行、取消、完了連番 |
| `application/report_coordinator.rs` | ジョブと固定履歴・設定・同意・モードの対応、ローカルカード作成 |
| `application/app_service/reports.rs` | 単一ワーカー、実時計での期限確認、保存後の snapshot 発行 |
| `application/app_service/storage_commands.rs` | 状態ロックと保存ロックを分離した参照・設定・削除・再試行 |
| `application/persistence.rs` | 世代付き保存と取消時の復元、保存失敗カードのメモリー参照 |
| `ipc/commands.rs` | 引数付き IPC を非同期化し、保存待ちを blocking worker へ渡す |
| `src/application/AppController.ts` | 即時完了と操作応答の順序逆転、同一カード再表示、表示キュー |

共通 DTO、A の Props、GIF・UI コンポーネントは変更していない。カードは既存 `ReportPanel` のローカル履歴カードとして表示する。AI 通信・AI 要約は B-07 の後続作業。

## 生成の経路

| 契機 | ジョブ登録時の扱い |
|---|---|
| 有効な Yes | 履歴を固定し queued。回答には受付済みの reportId を返す |
| 自然離席確定 | 顔欠落開始までの履歴を固定し scheduled。確定時刻＋5分が期限 |
| demo の自然離席 | 確定時刻＋5秒。通常の5分と同じ判定経路 |
| No | ジョブを作らない |
| 帰席 | 旧予約を維持。新セッションの履歴・通知とは別に進める |
| 同じセッションの再度の Yes | 既存 ID を返す。固定履歴・期限・試行を変えない |

履歴固定とジョブ登録は同じ状態ロック内で確定する。Yes 直後の離席・二重クリック・同じ requestId の再送でもジョブを増やさない。Domain の `report_requested` と Queue の sessionId 一意性を併用する。

期限は単調時計で比較し、dueAt は表示用 UTC。ワーカーは開始時に一度作り、停止・再開で再利用する。実行中は常に1件。未開始の即時要求・再試行を期限到達済み予約より優先し、予約同士は期限・登録順に処理する。実行中のジョブへ割り込まない。期限は通知または最大250ms間隔で確認する。

通常バッファが更新・破棄されても、ジョブは自分の固定コピーを持つ。後から作業した内容や別セッションは混ざらない。設定 revision・同意・実行モードも登録時点で保持する。

## 完成・失敗・再試行

ローカルカードは `Report.status: local / content: null` とし、マスク済み履歴・対象時間・契機を返す。履歴が空でもカードを作る。ジョブ側は ready。保存先から参照できる状態を確定してから completionSeq と snapshot を更新し、帰席や GIF 終了を待たずに既存 Controller の表示キューへ通知する。

保存失敗は `storageFailure` の failed カードと snapshot.warning にする。履歴を保った一時カードをメモリーの report_list / get から返すため、エラー内容と再試行操作を表示できる。通常の `reports.json` への保存成功とは扱わず、この一時カードは再起動で消える。既存の保存済み失敗カードへの一時的な更新も、同じ ID の表示を上書きするだけで原本を壊さない。

再試行は監視開始後、activity / history に同意した状態で受け付ける。対象の failed と expectedAttempt 一致を確認し、同じ ID・履歴・作成時刻を維持して attempt を増やす。現在の設定・同意を改めて固定する。実行中・完成済み・取消済みは拒否し、自動再試行しない。再起動後の保存済み failed も、明示的な要求があれば同じ ID でローカル生成できる。AI での再試行は B-07 で接続する。

新しい完成ごとに completionSeq を増やし、同じ ID の再試行完了も識別する。同一 runtime の削除では連番を戻さない。操作応答より先に完了イベントが届いても、再試行後の画面を読み込み中へ戻さず、Yes の完成で表示中の別カードを上書きしない。同じセッションの完成済みカードへの再度の Yes は、既存 ID を表示キューへ入れて再表示する。

## 停止・削除と保存の競合

状態と Persistence の Mutex を分け、生成・保存・参照で状態ロックを保持しない。WebView のメインスレッドにも保存を待たせない。長い保存中も snapshot・顔入力・Stop を進められる。複数の保存・設定変更・削除は保存ロック側で直列化する。

Stop・終了・再読み込みでは、状態と実行世代を先に無効化し、未完了ジョブを cancelled にする。data_clear は同じ無効化を行ってジョブとメモリー履歴を消してから、保存カードを消す。設定・キーは残す。削除の保存待ち中にも停止状態が見え、削除失敗の警告には新しい revision を付ける。

保存前後に実行世代を確認し、途中で取り消された保存は同じ保存ロック内で旧内容へ戻す。削除はその後で保存ロックを取得するため、遅い旧保存が削除済みデータを復活させない。完了反映時も世代・試行・running 状態を確認する。取消前に既に保存と完了が確定したカードは過去カードとして残る。

旧内容への復元自体も I/O なので、ディスク障害時は完全復旧を保証できない。復元に失敗した保存先は以後の参照・保存をブロックし storageFailure として扱う。元の正常内容を保全して保存先を確認する。旧世代の完了通知や保存成功を返して隠さない。

未実行予約・実行状態は永続化しない。再起動時に予約や送信を自動再開せず、保存済みカードを初回から勝手に新着表示しない。日次記録や姿勢判定は、この Queue やカード保存へ混ぜず別モジュールにする。

## 検証

2026-10-17、Windows 上で以下を確認。保存テストは一時ディレクトリとダミー情報を使い、普段のユーザーデータを読み書きしていない。

- Rust：83単体テスト＋登録済み IPC テスト1件。通常5分の単調時計判定、demo、Yes・離席の一意性、同時再送、複数予約と即時要求の優先順、帰席後の旧予約、空履歴、保存失敗・再試行を確認。
- 保存を意図的に待たせるテスト：待機中の Stop・削除が先に世代を進め、遅い完了を捨て、保存カード・通知を復活させない。古い試行の完了も拒否する。
- フロント：84テスト。離席中の即表示・複数完成の順番に加え、完了イベントと Yes／Retry 応答の順序逆転を確認。TypeScript・Vite build が成功。
- `report_probe`：実時計・実ワーカー・一時 JSON 保存で Yes の即時作成と自然離席確定＋5秒を実行。離席中の完成、マスク済みの履歴、completionSeq:1 → 2、削除成功を確認。PC 情報は架空、顔は手動 boolean で、実カメラ・実 PC タイトルは取得しない。
- `cargo fmt --check` と Tauri debug build（no-bundle）を確認。通常5分を実時間で待つ確認、実カメラ・実 WebView 画面での目視、ロック・スリープ復帰は未実施。後者の統合確認は B-08／09 で行う。

```powershell
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo run --manifest-path src-tauri/Cargo.toml --locked --example report_probe
npm.cmd run tauri -- build --debug --no-bundle
```

Windows の保存テスト・診断は、この実行環境のサンドボックス外の通常権限で成功を確認した。report_probe は最大85秒で終了し、実 PC・カメラや実サービスへ接続しない。
