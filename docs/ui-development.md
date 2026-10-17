# 表示担当向け：phase3 までの開発の入口

共通型、Gateway、接続用コントローラー、15シナリオのモックを使用する。B-09 で A の PochiApp と実センサー・保存・通信・Tauri ウィンドウ操作を接続した。[現在の表示構成](pochi-typescript.md) と [統合・デモの確認記録](backend-integration.md) を参照。以下のひな型の説明は先行開発時の参考として残す。

## 1. 起動と確認

`sd_2608` 直下で実行する。

```powershell
npm ci
npm run dev:mock
```

表示された URL（通常 `http://localhost:1420/`）をブラウザーで開く。カメラ権限・API キー・Rust は不要。試作版など同じポートのサーバーは先に終了する。

```powershell
npm test
npm run build
```

`npm test` は TypeScript の型検査と、Node 標準テストによるモック・コントローラーの検証を行う。追加のテストパッケージは不要。一時生成物は OS の一時ディレクトリへ出し、終了後に削除する。

`npm run dev` のブラウザー起動は Tauri 起動案内、`npm run tauri dev` と単体アプリは[統合したポチの表示](pochi-typescript.md)になる。モックは **開発時かつ mode が mock のときだけ** 動的に読み込む。`?window=1&scenario=multipleReports` ではデスクトップ相当の領域を確認できる。

## 2. 最初に読むファイルと変更範囲

| ファイル | 用途・担当 |
|---|---|
| [`src/contracts/ui.ts`](../src/contracts/ui.ts) | 表示担当の入口。`AppViewProps`、操作、各画面の Props |
| [`src/components/AppView.tsx`](../src/components/AppView.tsx) | A：表示の組み立て。Props を維持すれば内部の構成は変更できる |
| `src/components/PetStage.tsx` | A：GIF・ポーズ・演出。現在は単体 GIF の時間終了と割り込みの最小サンプル |
| `src/components/MessageBubble.tsx` | A：通常／強調の通知、Yes／No |
| `src/components/ReportPanel.tsx` | A：読み込み・成功・失敗・ローカル・空履歴・次のカード |
| `src/components/SettingsPanel.tsx` | A：設定フォーム。キーは入力時だけ渡し、読み戻さない |
| `src/styles/`、`src/presentation/`、`public/pet/` | A：スタイル、GIF manifest、素材 |
| `src/contracts/domain.ts`、`api.ts`、`ipc.ts` | B：共通 DTO と IPC 契約。変更が必要なら表示側と合意する |
| `src/ports/AppGateway.ts` | B：将来の実接続とモックの共通インターフェース |
| `src/application/` | B：古い応答の破棄、状態の表示用変換、完成カードの表示キュー |
| `src/adapters/mock/`、`src/dev/` | B：開発用シナリオ・時計操作。表示コンポーネントへ移植しない |
| `src/App.tsx`、`src/App.css`、依存・ビルド設定 | B：起動の接続と最小の全体スタイル。共通変更は先に相談する |

コンポーネントでセンサー・タイマー判定・HTTP・`invoke` を実装しない。使うのは `state` と `actions`。表示だけの状態（設定の開閉・GIF の再生位置など）はコンポーネントで管理してよい。

## 3. Props と操作の使い方

`AppView` には次の3つが渡される。型は `src/contracts/index.ts` からもまとめて import できる。

| Props | 主な内容 |
|---|---|
| `state.pet` | ポーズ・アニメーションのきっかけ・再生トークン・あいさつ・状態文言 |
| `state.bubble` | 通知がなければ null。文言・Yes／No ラベル・通常／強調表示 |
| `state.report` | `closed / loading / ready / error` の判別可能な union。ready のカード自体には `ready / failed / local` がある |
| `state.reportList`、`queuedReportCount` | 再表示するカード一覧、後続カードの件数 |
| `state.snapshot` | 接続前は null。取得状態・設定・在席時間・予約／生成中ジョブを参照できる |
| `state.pending`、`connection`、`error` | 操作中・接続中・接続エラー・操作エラー |
| `actions` | 開始、停止、Yes／No、設定保存、カード表示・閉じる・再試行、一覧更新、削除 |
| `petManifest` | 7つの素材の URL・再生時間・終了ポーズ |

例：休憩提案は `actions.answer("yes")` / `actions.answer("no")` を呼ぶ。通知 ID やセッション ID はコントローラーが付けるため、表示側で組み立てない。完成カードはコントローラーが自動で開くため、表示側で帰席を待たない。

画面の読み込み失敗と、レポート生成失敗は区別する。前者は `state.report.phase === "error"`、後者は `phase === "ready"` かつ `report.status === "failed"`。後者には元の履歴があり、再試行できる。

## 4. シナリオと phase ごとの確認

開発用コントロールで状態を選び、「同じ状態を再現」で初期化できる。時刻は自動では進まない。「+1秒／+10秒／+1分／+10分」を使う。通常シナリオの時間単位は分で、本番仕様の30分・60分を再現する。

| フェーズ | 表示担当が確認できるもの |
|---|---|
| phase1 | 起動・停止中、作業中、顔が一時的に見えない、センサーエラー |
| phase2 | 休憩しない？、No の延期中、60分の再通知、生成中、完成、失敗、ローカル履歴、履歴なし |
| phase3 | 離席・5分予約、帰席・旧予約あり、複数レポート完成、7つの GIF の個別プレビュー |

代表的な通し確認：

1. **Yes**：「休憩しない？」→ Yes →「+10秒」→ 固定応答のカードが即表示。
2. **No と区切り**：「休憩しない？」→ No →「+1分」を2回 →「新しい区切り」→ 再通知。
3. **No と上限**：「No の延期中」→「+10分」→ 再通知。「60分の再通知」→ No →5分進める→再通知。
4. **帰席後の旧予約**：「帰席・旧予約あり」→「+1分」を5回 →「+10秒」→ 新しい在席中に旧レポートが表示。
5. **失敗と再試行**：「レポート失敗」→ 再試行 →「+10秒」→ 同じ ID のカードが更新。
6. **完成キュー**：「複数レポート完成」→「次のカードへ」→ 2件目。現在のカードを完成イベントで上書きしない。

「離席を確定」「帰席を確定」はセンサー処理を飛ばし、確定状態を直接入力する。モックは画像検出、30秒安定化、スリープ・ロック、外部 API、永続化、実センサーの品質を検証しない。生成は2秒の仮処理であり、AI 応答は固定文。ページの再読み込みでデータは消える。

## 5. GIF の差し替えと演出

[`src/presentation/petManifest.ts`](../src/presentation/petManifest.ts) で7つの ID を維持したまま `src` を完成 GIF に、`durationMs` を実際の長さに差し替える。現在の2枚の SVG は、この作業用に作った仮素材。

| ID | 用途 |
|---|---|
| `launch` | 起動 |
| `runIn` | 走り込み |
| `welcome` | おかえりなさい |
| `idleRest` | 伏せ・休憩・待機ループ |
| `recordReminder` | 作業記録・休憩リマインダー |
| `sitToLie` | お座りから伏せ |
| `lieToSit` | 伏せからお座り |

個別プレビューを繰り返すと `playbackToken` が変わり、同じ素材を最初から再生できる。ひな型は GIF の終了時間で静止画像へ戻り、割り込み時に旧タイマーを解除する。素材が読めない場合と「動きを減らす」設定では静止画像を使う。

**登場の連続再生、ポーズ間の遷移、あいさつの表示時間は表示担当がここから仕上げる範囲。** 例：`launch → runIn → welcome → お座り`、`sitToLie → idleRest`、`lieToSit → recordReminder`。吹き出しと完成カードはこの連続演出の終了を待たずに出す。

## 6. ロジック担当が後で接続する範囲

TauriGateway と Rust の AppService、顔検出・Windows 取得、レポート予約・AI Provider・保存を実装し、`useAppController(realGateway)` と既存 `AppView` を接続する。IPC のコマンド表は `src/contracts/ipc.ts`、通信 DTO は `src/contracts/domain.ts` と `api.ts` にある。

実 Gateway はイベント購読・再同期・応答検証・カメラ解放を所有する。コントローラーは古い revision と旧接続の応答を破棄し、初回接続で過去カードを自動表示せず、新しい完成カードを表示キューへ入れる。契約を変更したらモックとこの資料も同じ変更で更新する。

型・モック・表示用コントローラーまでが今回の実装で、Rust の本番ロジックや完成した UI を実装済みとは扱わない。姿勢・日次記録は今回の契約へ混ぜず、[アーキテクチャ](architecture.md) の独立モジュールとして後から追加する。
