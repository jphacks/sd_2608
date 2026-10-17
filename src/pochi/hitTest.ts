import type { Point } from "../application/WindowClickThrough.js";

/** 物理座標から CSS 座標へ。負座標のモニターと表示倍率にも対応する。 */
export function clientPoint(cursor: Point, origin: Point, scale: number): Point {
  return { x: (cursor.x - origin.x) / scale, y: (cursor.y - origin.y) / scale };
}

export function spritePixel(point: Point, rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  width: number, height: number, columns: number, rows: number, frame: number): Point | null {
  const x = (point.x - rect.left) / rect.width, y = (point.y - rect.top) / rect.height;
  if (x < 0 || y < 0 || x >= 1 || y >= 1 || rect.width <= 0 || rect.height <= 0) return null;
  return { x: Math.floor((frame % columns + x) * width / columns),
    y: Math.floor((Math.floor(frame / columns) + y) * height / rows) };
}

export function createPochiHitTest(doc: Document): (point: Point) => boolean {
  const images = new Map<string, HTMLImageElement>();
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return point => {
    const surface = doc.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-pochi-hit]");
    if (!surface) return false;
    if (surface.dataset.pochiHit !== "sprite") return true;
    const sprite = surface.querySelector<HTMLElement>("[data-hit-src]");
    if (!sprite || !context) return true;
    const src = sprite.dataset.hitSrc!;
    let image = images.get(src);
    if (!image) {
      image = new Image();
      image.src = src;
      images.set(src, image);
    }
    // 読込失敗・読込中は操作を残す。GIF 自体ではなく現在フレームの PNG を参照。
    if (!image.complete || !image.naturalWidth) return true;
    const pixel = spritePixel(point, sprite.getBoundingClientRect(), image.naturalWidth, image.naturalHeight,
      Number(sprite.dataset.hitColumns ?? 1), Number(sprite.dataset.hitRows ?? 1), Number(sprite.dataset.hitFrame ?? 0));
    if (!pixel) return false;
    try {
      context.clearRect(0, 0, 1, 1);
      context.drawImage(image, pixel.x, pixel.y, 1, 1, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[3] !== 0;
    } catch { return true; }
  };
}
