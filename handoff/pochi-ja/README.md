# ポチ：引き継ぎ資料

通常起動する実装は **React + TypeScript版** です。C#版のZIPを展開する必要はありません。

- [TypeScriptの実装コード](../../src/pochi/)
- [操作・構成・ビルド方法](../../docs/pochi-typescript.md)
- [アニメーション素材](../../public/pet/pochi/)

リポジトリ直下で `npm ci` → `npm run dev` を実行します。Windowsのデスクトップ版は `npm run tauri dev` です。既存のセンサー・AIモックは `npm run dev:mock` で開けます。

## 配布資料

| ファイル | 内容 |
| --- | --- |
| [puppy-png-frames-v8.zip](./puppy-png-frames-v8.zip) | 採用済みの7グループ・107枚、512×512の透過RGBA PNG。各動作のmanifestとフレーム時間を同梱 |
| [puppy-transparent-gifs-v8.zip](./puppy-transparent-gifs-v8.zip) | 7グループの透過GIF。解凍後のindex.htmlで確認 |
| [workflow-ja.md](./workflow-ja.md) | 指定された11段階の操作 |
| [prototype-original.html](./prototype-original.html) | 受領した元プロトタイプ。旧文言・旧割り当てを含む参考資料 |
| [pochi-desktop-ja.zip](./pochi-desktop-ja.zip) | 旧C# / WPF版の実行ファイル。TypeScript版とは別 |
| [pochi-desktop-ja-source.zip](./pochi-desktop-ja-source.zip) | 旧C# / WPF版の全ソース。TypeScript版とは別 |
| [verification-ja.json](./verification-ja.json) | 旧C#版の196項目の検証記録。TypeScript版の検証結果ではない |

TypeScript版は `src/pochi/` と `public/pet/pochi/` を直接利用します。PNGアトラスは元画像の全画素を保持し、7シートから107フレームを再生します。動きの再生成や画像の引き伸ばしはしていません。

## 動作の対応

| 動作 | フレーム数 | 1回の時間 | 再生 |
| --- | ---: | ---: | --- |
| `idle` | 8 | 3600ms | ループ |
| `reminder` | 8 | 1440ms | 1回 |
| `rest` | 14 | 4200ms | ループ |
| `record` | 8 | 1760ms | 1回 |
| `welcome` | 20 | 2710ms | 1回、まばたき入り |
| `turn_sit` | 23 | 3320ms | 独立した一周→お座り |
| `rest_to_sit` | 26 | 2530ms | 第3版の起き上がり→正面に着席 |
| `sit_to_rest` | 26 | 2530ms | 起き上がり列と各表示時間を逆順で再生 |

`turn_sit` をお座り→伏せの代用にしないでください。GIFの透過は2値、TypeScript版のPNGアトラスは半透明の輪郭を保持します。走り込み専用の素材はありません。

TypeScript版の保存先はブラウザー／WebViewのlocalStorageです。旧C#版のJSON記録を自動で移行しません。レポートはアプリ内で確認し、外部AIやカメラには接続しません。
