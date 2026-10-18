import { useEffect, useLayoutEffect, useRef } from "react";
import { FramePlayback } from "./spritePlayback.js";

const images = new Map<string, Promise<HTMLImageElement>>();
export function releaseSpriteImage(src: string): void { images.delete(src); }
function decodedImage(src: string): Promise<HTMLImageElement> {
  const cached = images.get(src);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => fail(), 10_000);
    const cleanup = () => { clearTimeout(timer); image.onload = null; image.onerror = null; };
    const fail = () => { cleanup(); reject(new Error(`ポチの画像を読み込めません: ${src}`)); };
    image.onerror = fail;
    image.onload = () => { void image.decode().then(() => { cleanup(); resolve(image); }, fail); };
    image.src = src;
  });
  images.set(src, pending);
  void pending.catch(() => { if (images.get(src) === pending) images.delete(src); });
  return pending;
}

/** 全動作共通の描画面。decode 中も描画済みの画素とクリック情報を保持する。 */
export function useSpriteCanvas(onComplete: (token: number) => void, onReady?: () => void, onUnavailable?: () => void) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const playback = useRef<FramePlayback<HTMLImageElement> | null>(null);
  const callbacks = useRef({ onComplete, onReady, onUnavailable });
  useLayoutEffect(() => { callbacks.current = { onComplete, onReady, onUnavailable }; }, [onComplete, onReady, onUnavailable]);
  useEffect(() => {
    const surface = canvas.current!, context = surface.getContext("2d");
    if (!context) return;
    const player = new FramePlayback<HTMLImageElement>({
      load: decodedImage, now: () => performance.now(),
      request: callback => requestAnimationFrame(callback), cancel: handle => cancelAnimationFrame(handle),
      complete: token => callbacks.current.onComplete(token), ready: () => callbacks.current.onReady?.(),
      unavailable: () => callbacks.current.onUnavailable?.(),
      paint: (image, frame) => {
        const x = frame.frame % frame.columns * frame.tileWidth;
        const y = Math.floor(frame.frame / frame.columns) * frame.tileHeight;
        context.clearRect(0, 0, surface.width, surface.height);
        context.drawImage(image, x, y, frame.tileWidth, frame.tileHeight,
          0, frame.offsetY / frame.tileHeight * surface.height, surface.width, surface.height);
        Object.assign(surface.dataset, { hitSrc: frame.src, hitColumns: String(frame.columns),
          hitRows: String(frame.rows), hitFrame: String(frame.frame), hitOffsetY: String(frame.offsetY) });
      },
    });
    playback.current = player;
    const visibility = () => player.setHidden(document.hidden);
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); player.dispose(); playback.current = null; };
  }, []);
  return { canvas, playback };
}
