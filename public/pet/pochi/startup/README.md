# 起動時の入場

承認済みの短距離 v3「右上から走ってくる→減速→伏せる」を使用します。

- `run-in-prone.png`: 透過 APNG、960×640、107フレーム、25fps、4280ms、1回再生。
- `run-in-prone-atlas.png`: 実行用、3840×4480、480×320のセル8列×14行、先頭107コマを使用。元APNGから等比縮小してパック。
- `final-frame.png`: 同じキャンバスの最終フレーム。動きを減らす設定・読込失敗時の代替。

AIで作成した走行・減速・伏せのポーズをもとに構成した、このプロジェクト用の素材です。配布物に第三者のアニメーションを含めていません。元の各フレームは `puppy-run-in-prone-v3-png.zip` にまとめた別納品です。ランタイムはPNG図集を固定canvasへ描画します。APNGの独立した再生時計は使いません。`scripts/prepare-startup-atlas.py` で再生成でき、`scripts/audit-animation-assets.py` で全コマを元APNGと照合できます。

ソース全体には透明な余白があります。`src/pochi/startup.ts` の登録位置を使い、最終姿勢の横幅と足元を既存の170pxの伏せ画像に揃えます。
