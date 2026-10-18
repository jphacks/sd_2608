# API 設計書

作成日：2026-10-17。これは新しく実装する契約。プロトタイプのコマンドをそのまま公開するものではない。[型・データモデル](data-model.md) の DTO を共通で使う。

実装状況：B-01〜06 の通信・センサー・在席・通知・履歴・保存・予約に加え、B-07 のAI生成と失敗カード・再試行を実装済み。Yes は受付済みジョブの reportId を返し、完成後に completionSeq と app://snapshot で表示を通知する。詳細は [B-06 メモ](backend-report-coordinator.md)／[B-07 メモ](backend-ai-provider.md)。[表示開発ガイド](ui-development.md) のモックも利用できる。

## 1. API の境界

1. **UI → AppGateway**：A が使う TypeScript の接続口。実環境とモックで同じインターフェース。
2. **TauriGateway → Rust IPC**：監視・回答・設定・レポート参照。Rust の AppService が実行可否を検証する。
3. **FaceAdapter → Rust IPC**：顔有無の入力専用。動画や画像を渡さない。
4. **Rust → AI サービス**：Provider アダプターが形式差を吸収。UI から外部 API を直接呼ばない。
5. **Rust → OCR Adapter → Rust**：`app://ocr-request` と `ocr_complete` で一時画像を端末内のメイン WebView に渡し、認識文字だけを返す。業務用 AppGateway からは呼ばない。

今回、自前の HTTP サーバーや REST API は作らない。OS ウィンドウの移動・終了は専用 WindowAdapter に閉じ込め、UI コンポーネントへ Tauri の import を散らさない。

B-09 では AppGateway の任意の `window: WindowAdapter` と AppViewActions に演出・配置・最前面・ドラッグ・終了・再接続を追加した。IPC v1 と既存10コマンドは変更していない。Yes は `reminder_respond` に統一し、画面だけで休憩を開始する別経路は置かない。[統合記録](backend-integration.md) を参照。

休憩予告の追加では `AppSnapshot` に必須 nullable の `advanceNotice: { sessionId, remainingMs } | null` を追加した。タイミングは Rust Domain、表示文言と閉じたセッションの記憶は AppController が所有する。`dismissAdvanceNotice` は表示操作だけであり、新しい IPC コマンドや `reminder_respond` の呼び出しはない。Rust DTO・TypeScript Decoder・共通 JSON fixture を同時に更新しているため、フロントと Rust は同じビルドを使用する。

## 2. IPC 共通規則

- API v1。コマンド名は snake_case、要求・応答の JSON は camelCase。すべてのコマンドをメインウィンドウだけに許可する。
- 引数があるコマンドは `invoke(command, { request })` に統一する。引数なしは `invoke(command)`。
- 応答は `ApiResult<T>`。通信自体の例外は Gateway が `internal` または接続エラーとして正規化する。
- OCR 専用の `ocr_complete` は例外として受領可否の boolean を返す（下記）。
- 更新要求に `requestId` を付ける。同じ内容・同じ ID の再送は二重適用せず元の受付結果を返す。同じ ID で内容が違えば `validation`。
- 重複受付記録は当該プロセス内・最大1,000件。これとは別に通知 ID と `sessionId` ごとのジョブ一意性を永続的な業務条件として検証する。再起動をまたぐ自動再送はしない。
- 状態更新・回答・予約登録は直列化する。古い取得応答を新しい状態に適用しない。
- センサー入力・外部応答・保存データを実行時に検証する。TypeScript の型アサーションだけで正常と判断しない。

## 3. コマンド一覧

| コマンド | 要求 | 成功時の data | 主な検証・副作用 |
|---|---|---|---|
| `app_get_snapshot` | なし | `AppSnapshot` | 現在の全体状態。監視を開始しない |
| `runtime_start` | `StartRuntimeRequest` | `AppSnapshot` | 設定 revision、同意、AI 設定を検証。trackingId 採番、PC 取得開始 |
| `runtime_stop` | `StopRuntimeRequest` | `AppSnapshot` | trackingId 検証。取得停止、未実行予約取消、実行世代更新 |
| `face_submit` | `FaceInput` | `FaceReceipt` | trackingId・連番・鮮度を検証。顔入力だけを更新 |
| `reminder_respond` | `RespondReminderRequest` | `RespondReminderResult` | 通知 ID とセッションを検証。No は延期、Yes は即時ジョブ受付 |
| `settings_update` | `UpdateSettingsRequest` | `AppSnapshot` | 監視停止中だけ。設定 revision、接続先、キー変更を検証 |
| `report_list` | `ListReportsRequest` | `ReportPage` | 新しい順。本文・キーは一覧へ含めない |
| `report_get` | `{ reportId: Id }` | `Report` | 完成・失敗カード取得。存在しなければ `notFound` |
| `report_retry` | `RetryReportRequest` | `AppSnapshot` | 失敗済み・試行番号・監視中の同意を検証。同じ ID・履歴で再実行 |
| `data_clear` | `{ requestId: Id }` | `AppSnapshot` | 監視停止、予約取消、実行世代更新、履歴とカードを削除。設定・キーは保持 |

OCR 専用コマンド `ocr_complete` は `{ request: { requestId: string, text: string, failed: boolean } }` を受け、boolean を返す。メイン WebView からの現在の未回答要求だけを受領し、期限切れ・重複・他ウィンドウの応答を false にする。要求は `app://ocr-request` の `{ requestId, image: string | null }`。PNG data URL を1枚だけ渡し、null は worker の解放を指示する。画像を業務 snapshot や AI リクエストに含めない。

OCR の設定は `SettingsInput/View.ocrEnabled` の1項目。`HistorySnapshot.ocr` に取得時刻・履歴と一致した文字・失敗／不一致件数を保持する。`ActivitySegment.windowRef` は履歴照合用の不透明な参照で、AI へは送らない。[詳細](ocr-summary.md)。

`runtime_start` と PC 開始は1回にまとめる。カメラは TS 側のため、成功後に FaceAdapter を起動して同じ trackingId で入力する。開始失敗は `kind: unavailable` として即座に伝える。Rust は顔情報がそろうまで在席を判定しない。

`runtime_stop` 後は Gateway もカメラ・顔検出を終了する。Rust との通信が失敗してもカメラの解放を試み、停止確認ができない場合は UI に残す。

## 4. 要求・応答型

以下は [共通型](data-model.md) に追加する定義。`requestId` は Gateway が生成する。

```ts
export type StartRuntimeRequest = {
  requestId: Id;
  profile: TimingProfile;
  expectedSettingsRevision: number;
  reportMode: "local" | "ai";
  consent: { activity: boolean; history: boolean; externalReport: boolean };
};
export type StopRuntimeRequest = { requestId: Id; trackingId: Id };
export type FaceReceipt = { acceptedSequence: number; snapshotRevision: number };
export type RespondReminderRequest = {
  requestId: Id;
  trackingId: Id;
  sessionId: Id;
  reminderId: Id;
  answer: "yes" | "no";
};
export type RespondReminderResult = {
  snapshot: AppSnapshot;
  reportId: Id | null; // No は null、Yes は受付済みジョブの ID
};
export type UpdateSettingsRequest = {
  requestId: Id;
  expectedSettingsRevision: number;
  values: SettingsInput;
  keyChange: KeyChange;
};
export type ListReportsRequest = { cursor: string | null; limit: number };
export type ReportListItem = Pick<Report,
  "id" | "sessionId" | "createdAt" | "updatedAt" | "status">;
export type ReportPage = { items: ReportListItem[]; nextCursor: string | null };
export type RetryReportRequest = {
  requestId: Id;
  reportId: Id;
  expectedAttempt: number;
};
```

- `runtime_start` の `activity / history` は両方 true が必要。AI モードは `externalReport: true` と有効な Provider 設定・キーも必要。未同意・未設定では UI がローカルモードを案内し、`reportMode: local` で開始できる。
- 有効な開始要求で既に監視中なら、同一 requestId の再送以外は `invalidState`。新たに計測を始め直すには停止する。
- `face_submit` は1秒周期、同時送信は1件まで。sequence が前回以下の同一サンプルは受領済みとして返し、再評価しない。時刻や内容が矛盾する再送は拒否する。新規サンプルは5秒以内、未来へのずれは2秒以内を許容し、遅すぎる入力は計測に使わない。
- `source: manual` は demo プロファイルだけに許可し、画面に手動テストと明示する。
- B-03 の顔入力受付結果は最新1,000件を保持する。キャッシュ外の古い連番や、同じ trackingId 内で source を変えた新規入力は validation。再送で入力の鮮度を延ばさない。
- `reminder_respond` は失効した通知へ `staleReminder`。同じ要求の再送は成功結果を返すが、別要求で回答済み通知へ回答し直せない。
- B-06 の Yes は reportId を返し、No は null。同一セッションの再度の Yes は既存 ID を返す。自然離席は確定時刻＋5分（demo は5秒）を dueAt とし、内部の単調時計で判定する。帰席で取り消さない。local カードは job.status:ready / report.status:local / content:null で返す。
- `settings_update` はキーを応答へ返さず `hasApiKey` のみ返す。Provider の形式・接続先変更時は旧キーを流用せず、新規キー登録が必要。設定変更で送信同意は引き継がない。
- 設定保存は停止中・設定 revision 一致が条件。除外アプリは実行ファイル名を最大100件・各200文字。endpoint は2,048文字、model は200文字、キーは空白・制御文字なしの ASCII で最大4,096バイト。HTTPS、またはループバックの HTTP に限り、URL の認証情報・クエリー・フラグメントは拒否する。B-07でAIモードの開始・再試行も接続した。モデルは空不可で前後の空白を拒否し、Geminiでは英数字・ハイフン・アンダースコア・ピリオドに制限する。
- `report_list` の limit は1〜20。cursor は不透明なページ位置。削除後の古い cursor は再取得を案内する。
- B-05 の cursor はプロセスとカード一覧の世代に結び付く。新規保存・更新・期限整理・削除・再起動の後は、cursor:null から取得し直す。読み出しでも7日の保持期限を確認する。保存失敗は storageFailure とし、data_clear では失敗しても監視停止・実行世代更新を先に確定する。
- `report_retry` は元の固定履歴と現在の明示的同意を使う。現在の設定 revision をジョブへ取り込み、接続先が変わっていたら、その接続先で送ることを UI で確認してから再試行する。過去の失敗カードも同じ ID で再試行可能。
- 再試行は監視開始後の activity / history 同意、failed 状態と expectedAttempt 一致が条件。同じ ID・履歴・作成時刻を維持して attempt を増やす。現在の監視方式がAIならexternalReport同意と有効な設定・キーも必要で、UIは現在の送信先・モデルを毎回確認する。queued / running / ready / cancelled は拒否する。保存失敗のカードは error.code:storageFailure の failed としてメモリーから参照できるが、再起動で消える。保存成功は装わず、warning にも失敗を返す。
- 保存を伴う IPC は非同期コマンドから blocking worker へ渡し、WebView のメインスレッドを保存待ちで止めない。snapshot・顔入力・Stop は保存ロックを待たない。削除完了時に警告が変わった場合も revision を進める。

## 5. 状態イベントと同期

業務状態の Tauri イベントは **`app://snapshot`** とし、payload は `AppSnapshot` 全体。状態更新後に発行する。時間表示だけの更新は毎秒まで、通知・ジョブ完了・停止は即時発行する。OCR 専用の `app://ocr-request` はメイン WebView だけに送る一時データで、snapshot の同期とは独立する。

接続の手順は次の順とする。

1. イベントを購読し、一時的に受信をバッファする。
2. `app_get_snapshot` を取得し、同じ runtimeId 内で最も新しい revision を採用する。
3. バッファを revision 順に処理し、以後は採用済み以下の revision を捨てる。
4. 5秒ごとの再取得と画面復帰時の再取得でイベント欠落を補う。runtimeId が変わったらキャッシュ・入力 trackingId・表示キューを初期化して再接続する。

同じ runtimeId の古いコマンド応答で状態を巻き戻さない。旧接続の runtimeId の応答は、接続世代が一致しなければ破棄する。

レポートは `completionSeq` の増加で完成を検知し、対応する jobs の ID を取得して `report_get` → 自動表示する。初回接続では既存 completionSeq を基準値として、過去カードを勝手に開かない。接続中の取りこぼしは snapshot 内の jobs から補完する。失敗カード・再試行完了も同様に扱う。

## 6. UI が使う Gateway

```ts
export interface AppGateway {
  connect(onSnapshot: (state: AppSnapshot) => void, onConnectionError?: (error: ApiError | null) => void): Promise<AppSnapshot>;
  start(input: Omit<StartRuntimeRequest, "requestId">): Promise<ApiResult<AppSnapshot>>;
  stop(trackingId: Id): Promise<ApiResult<AppSnapshot>>;
  respond(input: Omit<RespondReminderRequest, "requestId">):
    Promise<ApiResult<RespondReminderResult>>;
  updateSettings(input: Omit<UpdateSettingsRequest, "requestId">):
    Promise<ApiResult<AppSnapshot>>;
  listReports(input: ListReportsRequest): Promise<ApiResult<ReportPage>>;
  getReport(reportId: Id): Promise<ApiResult<Report>>;
  retryReport(input: Omit<RetryReportRequest, "requestId">):
    Promise<ApiResult<AppSnapshot>>;
  clearData(): Promise<ApiResult<AppSnapshot>>;
  dispose(): Promise<void>;
}
export interface FaceInputPort {
  submit(input: FaceInput): Promise<ApiResult<FaceReceipt>>;
}
```

Gateway が操作ごとに requestId を生成し、同じ操作の再送では維持する。Presenter は処理中表示とボタンの二重操作防止を管理する。取得失敗時もエラーと再取得を出す。`dispose` は購読・ポーリング・カメラを解放し、ブラウザー再読み込みではバックエンドの監視停止も行う。Rust 側のページ再読み込み検出も停止処理を実施する。

MockGateway は時計を進めて在席・離席・No・60分・レポート成功／失敗を再現する。実センサーも外部通信も使わず、同じ ApiResult と revision の規則に従う。

## 7. AI Provider の契約

内部インターフェースは `ReportProvider::generate(settings, key, history, current) → Result<ReportContent, ApiError>`。HTTPアダプターが固定履歴から送信テキストを作り、固定の指示を付ける。Gemini と OpenAI 互換 Chat Completions に対応し、`current`で停止・削除・世代切替を検出する。

| 項目 | 設計 |
|---|---|
| 入力 | 固定・マスク済みのアプリ名、タイトル、区間時刻。映像・画像・キー入力内容は含めない |
| 出力 | `summary: string`、`observedFacts: string[]`、`nextAction: string \| null` の JSON |
| 検証上限 | summary 2,000文字、facts 最大10件・各300文字、nextAction 500文字、応答本文64 KiB |
| 通信 | 60秒タイムアウト、リダイレクトに従わない、並列数1、自動再試行なし |
| 接続先 | HTTPS。開発用の端末内 API に限り loopback HTTP を許可。URL 内の認証情報は許可しない |
| 失敗 | HTTP・認証・不正 JSON・スキーマ不一致をカードの失敗へ変換。生レスポンス・キーを UI やログへ出さない |

Provider 設定の endpoint は形式ごとに検証する。Gemini はベース URL にモデルの generateContent パスを組み立て、互換形式は Chat Completions の完全な URL として扱う。API キーは Rust が読み出して必要な認証ヘッダーへ設定し、フロントへ読み戻さない。

固定入力は設定revision・同意・モード・秘密の保存IDを含む。履歴が空なら通信・復号をせずlocalカードにする。AI失敗は同じ履歴を持つfailedカードを保存して通知し、生レスポンスは渡さない。実装・制限・実サービスの未検証事項は [B-07 メモ](backend-ai-provider.md) を参照。

## 8. 代表的な競合とエラー

| ケース | 結果 |
|---|---|
| Yes と自然離席が同時 | AppService の受付順に1ジョブだけ登録。離席で通知が失効済みなら Yes は staleReminder |
| 停止後の顔入力 | staleTracking。計測を再開しない |
| No 後の古い画面から Yes | staleReminder。最新状態を取得して表示を合わせる |
| 実行中に停止・削除 | 世代不一致の完了を破棄。削除済みカードを復活させない |
| AI 応答不正 | invalidResponse の失敗カード。履歴は保持し、明示的再試行だけ許可 |
| 設定の同時保存 | expectedSettingsRevision 不一致で staleRevision。再取得後に編集し直す |

IPC と MockGateway の契約テストでは、正常系に加えてこれらのケースを共通フィクスチャーで確認する。
