# ポチ：統合した TypeScript の表示

A の犬・吹き出し・透過 PNG アトラスを、既存の AppController／AppGateway と Rust の在席・レポート処理に接続しました。起動・デモ・確認結果は [B-08／B-09 の記録](backend-integration.md) を参照してください。

## 操作

- ポチの単クリック：停止中は開始と同意、監視中は最新レポートの再表示。
- ダブルクリック：設定。単クリックの待機処理を取り消します。
- Yes：現在の通知 ID を回答し、即時レポート作成。起立を断定せず連続在席を維持します。
- No：Rust の通知ルールで延期。レポートは作成しません。
- 自然離席：通常30秒（demo 5秒）で確定し、確定から5分（demo 5秒）後に作成。完成カードは帰席を待たず表示。
- 記録：Rust に保存したレポート一覧と再表示。
- 監視を停止：センサー・予約・実行中ジョブを停止。
- 終了：停止を確認してウィンドウを閉じます。OS の閉じる操作・ページ再読込でも Rust 側で停止します。
- Escape：設定・履歴を閉じる、または通知に No、カードを閉じる。

旧手動フローの作業名・作業／勉強・休憩メモ・手動の「戻ったよ」と localStorage による状態復元は廃止しました。保存済み設定・カードだけを Rust で復元し、監視は自動再開しません。旧 `pochi.manual.v1` は読み書き・移行・削除しません。

## ソースの入口

| ファイル | 責務 |
| --- | --- |
| `src/application/AppController.ts` | snapshot の採用、回答、カード表示キュー、演出のきっかけ、ウィンドウ操作の転送 |
| `src/ports/AppGateway.ts` | 本番とモックに共通の操作・購読ポート |
| `src/adapters/tauri/TauriGateway.ts` | IPC、応答検証、再同期、カメラの寿命 |
| `src/ports/WindowAdapter.ts` / `src/adapters/tauri/WindowAdapter.ts` | 最前面、移動、終了、倍率・作業領域を考慮した配置 |
| `src/pochi/PochiApp.tsx` | A の表示。Props と actions だけを使用 |
| `src/pochi/animation.ts` / `atlases.json` | 7動作・107フレームの時間、逆再生、割り込み |
| `src/pochi/PochiSprite.tsx` | PNG アトラスの再生、画像失敗時の静止画、動きを減らす設定 |
| `src/components/ReportPanel.tsx` / `SettingsPanel.tsx` | 共通レポートと AI 設定・除外・削除 |
| `src-tauri/src/domain/` | 在席・通知・履歴・予約の正規状態と時計による判定 |

PochiController と重複する TypeScript の計時・保存モデルは削除しました。アニメーション完了では在席やレポートを変更しません。通知・カードはアニメーション完了を待たず表示し、毎秒の snapshot で同じ演出を再開しません。

`idle`、`reminder`、`rest`、`record`、`welcome`、`turn_sit`、`rest_to_sit` を使用します。`sit_to_rest` は起き上がりのフレーム・時間の逆順です。採用済み素材の画素は変更していません。

## 表示確認

`npm run dev:mock` は同じ AppController と表示を使い、15シナリオと注入時計を操作できます。`?window=1&scenario=multipleReports` でデスクトップ相当の表示を確認できます。ブラウザーの表示領域を440×760、380×640にして、吹き出し内スクロールと常設操作を確認します。これを実機の DPI・透過・ドラッグ確認とは区別します。
