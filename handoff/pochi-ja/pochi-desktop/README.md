# ポチ：Windows デスクトップ版のソースコード

このディレクトリには、ZIPを展開せずに読めるC# / WPFのソースと、ビルドに必要な素材を置いています。日本語版1.1の参考実装です。

## ビルドと自動チェック

Windows 10 / 11 と .NET Framework 4.x（4.8推奨）が必要です。Windows標準のC#コンパイラを使うため、追加のNuGetパッケージや.NET SDKは不要です。

このディレクトリでPowerShellを開いて実行します。

```powershell
.\build.ps1 -Test
.\dist-ja\Pochi.exe
```

`-Test` はテスト専用の保存先 `test-artifacts/domain/` を使います。通常の利用記録は変更しません。

## コードの入口

| ファイル | 実装 |
| --- | --- |
| [src/Program.cs](./src/Program.cs) | 起動、コマンドライン引数、例外処理 |
| [src/PetWindow.cs](./src/PetWindow.cs) | ペット画面、クリック、作業開始、休憩通知、復帰 |
| [src/Animation.cs](./src/Animation.cs) | PNGの読み込み、フレーム時間、1回再生とループ |
| [src/Domain.cs](./src/Domain.cs) | 作業・休憩の状態、時間、回数、設定 |
| [src/Storage.cs](./src/Storage.cs) | ローカル保存と復元 |
| [src/SettingsWindow.cs](./src/SettingsWindow.cs) | 日本語の設定画面 |
| [src/ReportWindow.cs](./src/ReportWindow.cs) | アプリ内の作業・休憩レポート |
| [src/Ui.cs](./src/Ui.cs) | 共通の画面部品 |
| [src/SelfTests.cs](./src/SelfTests.cs) | 自動チェック |
| [src/AssemblyInfo.cs](./src/AssemblyInfo.cs) | アプリのバージョン |
| [build.ps1](./build.ps1) | コンパイル、素材の埋め込み、自動チェックの実行 |
| [assets/manifest.json](./assets/manifest.json) | 動作ごとのフレーム順序・表示時間・ループ設定 |

`assets/` には7グループ・107枚の透過PNG、アイコン、通知チャイムがあり、ビルド時に実行ファイルへ埋め込みます。「お座り→伏せ」は `rest_to_sit` のフレームと表示時間を逆順にして再生します。

## このリポジトリ本体との関係

本体のReact / Tauriとは別の、Windows上で動作する参考実装です。既存のReact / Tauriへの組み込み手順・素材ID対応は[引き継ぎ説明書](../README.md)に記載しています。

利用方法と記録の保存先は [README-ja.txt](./README-ja.txt)、指定された11段階の操作は [workflow-ja.md](../workflow-ja.md) を参照してください。カメラ検出、音声入力、外部AIとの通信は未接続です。
