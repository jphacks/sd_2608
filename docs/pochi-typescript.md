# ポチ：統合した TypeScript の表示

PR #5 の GIF・配色・右下の犬・吹き出し・設定ボタン・メニューを、main の PochiApp を基準に取り込みました。AppController／AppGateway／TauriGateway、Rust、設定・レポートの型と共通パネルは変更していません。起動・デモ・バックエンドの確認結果は [B-08／B-09 の記録](backend-integration.md) を参照してください。

## 操作

- ポチの単クリック：停止中は開始と同意、監視中はメニュー。
- ダブルクリック：設定。単クリックの待機処理を取り消します。
- 歯車：設定。監視中は設定値を編集できません。
- メニュー：保存したレポート・設定・監視停止。「その他の操作」に最新レポート・ひとまわり・デスクトップの移動と終了を配置。
- 開始案内だけを2.4秒後に隠して状態チップを表示します。通知・生成中・予約・レポート・警告・エラーは隠しません。
- Yes：現在の通知 ID を回答し、即時レポート作成。起立を断定せず連続在席を維持します。
- No：Rust の通知ルールで延期。レポートは作成しません。
- 自然離席：通常30秒（demo 5秒）で確定し、確定から5分（demo 5秒）後に作成。完成カードは帰席を待たず表示。
- 記録：Rust に保存したレポート一覧と再表示。
- 監視を停止：センサー・予約・実行中ジョブを停止。
- 終了：停止を確認してウィンドウを閉じます。OS の閉じる操作・ページ再読込でも Rust 側で停止します。
- Escape：設定・履歴を閉じる、または通知に No、カードを閉じる。

旧手動フローの作業名・作業／勉強・休憩メモ・手動の「戻ったよ」と localStorage による状態復元は廃止しました。保存済み設定・カードだけを Rust で復元し、監視は自動再開しません。旧 `pochi.manual.v1` は読み書き・移行・削除しません。

## デスクトップのクリック透過

Tauri の通常版・短縮デモでは、透明な背景とペット画像の透明画素のクリックを背後のアプリへ渡します。ペットの不透明部分、吹き出し、歯車、状態チップ、デモの手動顔入力は操作できます。タスクバーにはアイコンを表示しません。終了・移動はペットのメニューまたは設定の「その他の操作」を使います。

`src/application/WindowClickThrough.ts` が入力の保持・透過切替・解放を管理し、`src/adapters/tauri/startClickThrough.ts` が OS の物理カーソル座標をウィンドウ内の CSS 座標に変換します。透過中は DOM のマウスイベントが届かないため、32ms 間隔の OS 座標取得でも操作領域への復帰を検出します。ウィンドウ位置・表示倍率は毎回取得し、移動や別モニターでも再計算します。押下中のドラッグ・文字選択は透過を切り替えず、解放時に再判定します。終了時と取得エラー時は透過を解除します。

`data-pochi-hit` が表示中の操作領域です。ペットは `data-pochi-hit="sprite"` とし、`PochiSprite` の現在フレームに対応する PNG アトラスのアルファ値を参照します。静止画・画像失敗時・動きを減らす設定でも表示中の静止画を参照します。画像読込中・読込失敗時はペットの操作を優先します。操作領域を追加したらこの属性も付けてください。ブラウザーのモックでは OS の透過 API を呼びません。

検証結果：`npm test` 101件、`npm run build`、Rust のテスト97件、`cargo fmt --check` が成功。`npm run dev:mock` の `/tests/browser/window-click-through-smoke.html` でも背景・歯車・吹き出し・設定入力と、実画像の不透明・透明画素の計225点の判定一致を確認しました。これは DOM と画像の検証です。Windows の背後アプリへの実クリック、タスクバーの見た目、表示倍率を変えた実機操作は未確認です。

`node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle` も成功し、`src-tauri/target/debug/sd_2608.exe` を生成しました。インストーラーの作成は検証範囲に含めません。

実機での確認手順：

1. `npm run tauri dev` で起動し、タスクバーにポチのアイコンが出ないことを確認する。
2. メモ帳などを背後に置き、ウィンドウの透明部分とペットの透明な余白から背後のアプリをクリックできることを確認する。
3. ペットのクリック・ダブルクリック、歯車、Yes／No、設定入力、吹き出し内スクロールが動作することを確認する。
4. メニューの「ウィンドウを移動」で移動し、100%／150%／200% 表示と別モニターで2〜3を繰り返す。
5. 「アプリを終了」で閉じられることを確認する。短縮デモでも手動顔入力ボタンを確認する。

## ソースの入口

| ファイル | 責務 |
| --- | --- |
| `src/application/AppController.ts` | snapshot の採用、回答、カード表示キュー、演出のきっかけ、ウィンドウ操作の転送 |
| `src/ports/AppGateway.ts` | 本番とモックに共通の操作・購読ポート |
| `src/adapters/tauri/TauriGateway.ts` | IPC、応答検証、再同期、カメラの寿命 |
| `src/ports/WindowAdapter.ts` / `src/adapters/tauri/WindowAdapter.ts` | 最前面、移動、終了、倍率・作業領域を考慮した配置 |
| `src/pochi/PochiApp.tsx` | A の表示。Props と actions だけを使用 |
| `src/pochi/animation.ts` / `atlases.json` | 7動作・107フレームの時間、逆再生、割り込み |
| `src/pochi/gifPresentation.ts` / `reference-gifs.json` | 既存の Motion から表示用 GIF への対応と原本の SHA-256 |
| `src/pochi/PochiSprite.tsx` | GIF と逆再生 PNG の表示、main の時間・トークンによる完了通知、画像失敗時と動きを減らす設定の静止画 |
| `src/components/ReportPanel.tsx` / `SettingsPanel.tsx` | 共通レポートと AI 設定・除外・削除 |
| `src-tauri/src/domain/` | 在席・通知・履歴・予約の正規状態と時計による判定 |

PochiController と重複する TypeScript の計時・保存モデルは削除しました。アニメーション完了では在席やレポートを変更しません。通知・カードはアニメーション完了を待たず表示し、毎秒の snapshot で同じ演出を再開しません。

`idle`、`reminder`、`rest`、`record`、`welcome`、`turn_sit`、`rest_to_sit` の GIF 原本をそのまま使用します。GIF 内蔵の繰り返し指定によらず、main の `frameAt` と再生トークンで `actions.completeAnimation` を呼びます。通知・記録・歓迎・回転・起き上がりは main の一回動作のままです。`sit_to_rest` は従来の PNG アトラスで起き上がりのフレーム・時間を逆順に再生し、伏せへの遷移を維持します。

PR #5 の PochiController・model・repository・desktop、手動休憩フロー、未対応の音声・音・カメラ方式・通知間隔設定は採用していません。設定保存・履歴参照・再生成は main の型と actions を使います。

## 表示確認

`npm run dev:mock` は同じ AppController と表示を使い、15シナリオと注入時計を操作できます。`?window=1&scenario=multipleReports` でデスクトップ相当の表示を確認できます。

UI 取り込み時に `npm test`（93件）と `npm run build` が成功しました。ブラウザーで同意前の開始禁止、開始後のチップ表示、監視中の設定無効化、Yes で即時生成し在席時間を維持、No では生成しない、帰席後も予約を維持、保存レポート一覧、複数カードの順送りを確認しました。440×760 の設定と380×640 のレポートで吹き出し内スクロール・横方向のはみ出しがないことを確認しています。実機の DPI・透過・ドラッグは今回のブラウザー確認の対象外です。
