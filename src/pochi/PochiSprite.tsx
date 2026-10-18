import { useEffect, useLayoutEffect, useRef } from "react";
import type { Motion } from "./animation.js";
import { SpritePlayback, spriteSize } from "./spritePlayback.js";

const images = new Map<string, Promise<HTMLImageElement>>();
function decodedImage(src: string): Promise<HTMLImageElement> {
  const cached = images.get(src);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => fail(), 10_000);
    const cleanup = () => { clearTimeout(timer); image.onload = null; image.onerror = null; };
    const fail = () => { cleanup(); reject(new Error(`ポチの画像を読み込めません: ${src}`)); };
    image.onerror = fail;
    image.onload = () => {
      // decode 完了後だけ切り替える。src の変更による空白フレームを作らない。
      void image.decode().then(() => { cleanup(); resolve(image); }, fail);
    };
    image.src = src;
  });
  images.set(src, pending);
  void pending.catch(() => { if (images.get(src) === pending) images.delete(src); });
  return pending;
}

export function PochiSprite({ motion, reducedMotion, onComplete }: {
  motion: Motion; reducedMotion: boolean; onComplete(token: number): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const playback = useRef<SpritePlayback<HTMLImageElement> | null>(null);
  const complete = useRef(onComplete);
  useLayoutEffect(() => { complete.current = onComplete; }, [onComplete]);
  useEffect(() => {
    const surface = canvas.current!, context = surface.getContext("2d");
    if (!context) return;
    const player = new SpritePlayback<HTMLImageElement>({
      load: decodedImage, now: () => performance.now(),
      request: callback => requestAnimationFrame(callback), cancel: handle => cancelAnimationFrame(handle),
      complete: token => complete.current(token),
      paint: (image, frame) => {
        const x = frame.frame % frame.columns * spriteSize;
        const y = Math.floor(frame.frame / frame.columns) * spriteSize;
        // 同じ canvas へ同期的に描画。動作変更時も要素と解像度を維持する。
        context.clearRect(0, 0, spriteSize, spriteSize);
        context.drawImage(image, x, y, spriteSize, spriteSize, 0, frame.offsetY, spriteSize, spriteSize);
        Object.assign(surface.dataset, { hitSrc: frame.src, hitColumns: String(frame.columns),
          hitRows: String(frame.rows), hitFrame: String(frame.frame), hitOffsetY: String(frame.offsetY) });
      },
    });
    playback.current = player;
    const visibility = () => player.setHidden(document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); player.dispose(); playback.current = null; };
  }, []);
  useEffect(() => { playback.current?.setMotion(motion, reducedMotion); }, [motion, reducedMotion]);
  return <canvas ref={canvas} className="dog" width={spriteSize} height={spriteSize} role="img" aria-label="ポチ">ポチ</canvas>;
}
