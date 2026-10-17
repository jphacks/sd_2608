# B-03：顔検出と入力の橋渡し

対象：`feat/backend-face-detection`。B-02 を `develop/backend` へ取り込んだ `4eff08f` から分岐。[B担当の計画](backend-development-plan.md) の B-03 に対応する。

## 実装した範囲

| 層 | 主なファイル | 責務 |
|---|---|---|
| カメラの接続口 | `src/ports/FaceCapture.ts` | 開始・停止と、顔の有無／取得不可の送信 |
| 取得・検出 | `src/adapters/camera/FaceDetectionController.ts` | カメラ、video、検出器、タイマーの所有と解放。約1秒周期の直列送信 |
| ブラウザー依存 | `src/adapters/camera/browserCamera.ts` | getUserMedia と MediaPipe。CPU 推論、音声なし、モデルと WASM は端末内 |
| Gateway | `src/adapters/tauri/TauriGateway.ts` | Rust の開始成功後に同じ trackingId でカメラを開始。停止・削除・解除・再接続・旧応答への対応 |
| Rust の受付 | `src-tauri/src/application/face_input.rs` | trackingId 照合後の連番・時刻・source・再送・鮮度の管理 |
| 状態反映 | `src-tauri/src/application/app_service.rs` | camera 状態、unknown、取得失敗や手動入力の案内。現在の顔入力を B-04 へ引き渡す入口 |

試作版の `src/features/camera/faceDetector.ts` を参考に、取得元・時計・タイマー・送信を注入できる構成へ移植した。Wire DTO、既存10コマンド、A の Props は変更していない。開発用の手動入力パネルは B の `RuntimeApp` に置き、通常の表示コンポーネントからセンサーへの依存を増やしていない。

## 起動と現在の動作

```powershell
npm ci
npm run tauri dev
```

通常の「開始」で同意すると PC 取得が開始し、その成功後にカメラを起動する。`camera=waiting` → 最初の正常入力で `running`。顔なしも正常入力であり、カメラの異常とは区別する。権限拒否・切断・モデル／推論失敗・フレーム停止は unavailable として送信し、camera は error、在席は unknown にする。

**B-03 は顔入力の接続まで。** 在席判定・連続在席時間・区切り・通知は B-04、保存は B-05、レポートは B-06〜07。顔ありでも presence は unknown のままとし、画面には検出入力と未接続機能を説明する。AI 開始・設定保存は引き続き未接続。

Stop・削除・dispose・ページ離脱では、Rust の応答を待つ前にカメラを解放する。再読み込み・本体終了は既存の Rust 停止処理でも trackingId を失効させる。許可やモデル読込が停止後に完了しても、その旧ストリーム／検出器だけを閉じる。外部からの停止イベントや runtime 切替でもカメラを終了する。

権限待ちは30秒、video 再生待ちは10秒、検出器読込は15秒で打ち切る。新しいフレームが5秒来ない場合は取得を止める。IPC が5秒応答しない場合もカメラを閉じるが、先行要求が終わるまで次の送信を開始しない。エラーを「顔なし」に置き換えたり、再送・自動再開したりしない。

## Rust の受付規則

- 実行中の trackingId だけを受け付ける。停止・再開始・削除後の入力は staleTracking。
- sequence は1以上で増加、observedAt は前回以上。新規入力は過去5秒以内・未来へのずれ2秒以内。同じ trackingId で camera と manual を混在させない。
- 最新1,000件の連番・内容の照合子・受付結果だけを記録する。同一内容の再送は元の FaceReceipt を返し、revision・鮮度・入力を更新しない。異なる内容や、キャッシュから外れた古い連番の再利用は validation。
- 受信時点での入力の古さと単調時計を合わせて5秒を超えた入力を破棄する。PC ワーカーの更新と snapshot の再取得で camera=error / unknown に反映する。古い再送では復活しない。
- 映像・座標・画像・カメラ名は IPC・保存・ログに渡さない。保持する顔入力は現在の boolean・source・取得時刻と内部の鮮度情報だけ。停止で消す。

## モデル・WASM の同梱

`@mediapipe/tasks-vision` は試作版と同じ **0.10.35** に固定した。`public/models/` に BlazeFace short-range float16 / 1 と出典・Apache-2.0 を格納し、準備時に SHA-256 を照合する。OCR は移植していない。

`npm ci` の postinstall と dev / build の事前処理が、インストール済み SDK の対応 WASM 全種類・SDK README・ライセンスを `public/mediapipe/` へコピーする。生成物は Git 対象外で、Vite の dist と Tauri のビルドに含まれる。SDK の npm 配布物に LICENSE 本文がないため、同じ Apache-2.0 の全文を同梱する。CDN への実行時フォールバックはない。

`npm ci --ignore-scripts` を使った環境では `npm run assets:prepare` を実行する。モデルの固定 hash、出典は `public/models/README.md` を参照。

## 検証結果と残る実機確認

- `npm test`：81件。既存テストに、カメラの世代・直列送信・タイムアウト・権限拒否・切断・遅い解放、Gateway の起動・停止・削除・離脱・再接続・手動入力を追加。
- Rust：単体28件＋IPC統合1件。連番・鮮度の境界、再送、source、キャッシュ上限、停止後の拒否、登録済み IPC での顔入力受理を確認。
- `npm run build`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo test --manifest-path src-tauri/Cargo.toml --locked`、`npm.cmd run tauri -- build --debug --no-bundle` を確認。
- ブラウザーの模擬映像テストで、実 SDK・同梱 WASM／モデルを読み込み、2回の起動で計6件の「顔なし」を推論し、停止後に全 Track が ended となることを確認。実カメラは使用していない。
- **本体の実カメラでの許可・顔を出す／隠す・切断、カメラ使用ランプの消灯は未確認。** 以下の手順で実機確認する。模擬映像と IPC のテストを、実カメラ確認済みとは扱わない。

実機では、開始直後の停止、許可後に顔を出す／隠す、USB カメラの切断、停止・再開・再読み込みを試す。画面の顔あり／なしの案内とエラーを確認し、停止後にカメラが残らず、再開後の旧結果が混ざらないことを見る。

カメラを使わず本体を確認する場合は、`tauri dev` の「開発用：手動の顔入力」で同意して開始し、顔あり／なしを切り替える。profile=demo、source=manual と「手動テスト（カメラ不使用）」の表示で実カメラと区別する。通常 profile の manual は Rust でも拒否し、本番ビルドには操作パネルを含めない。

モデルだけの模擬映像確認は `npm run dev` で起動し、`/tests/browser/face-capture-smoke.html` を開く。完了時に `PASS`・`samples:6`・`allTracksStopped:true` を表示する。このページは開発サーバー用で、本番の dist に含めない。

## 次の作業

B-04 は `FaceObservation` と PC の内部サンプルから在席・セッション・区切り・通知を判定する。顔入力の単なる再送を新しい観測に数えず、source・鮮度・取得不可を使って安全に unknown へ戻す。B-03 の unknown 固定と未接続案内を、その実装と合わせて置き換える。
