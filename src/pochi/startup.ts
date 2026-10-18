import type { FrameSequence, SpriteFrame } from "./spritePlayback.js";
/** Approved short-distance v3: 107 transparent frames, played once per app mount. */
export const arrival = {
  src: "/pet/pochi/startup/run-in-prone.png",
  poster: "/pet/pochi/startup/final-frame.png",
  atlas: "/pet/pochi/startup/run-in-prone-atlas.png",
  width: 960, height: 640, frameCount: 107, durationMs: 4280,
} as const;

// Match the final visible dog to the existing 170px resting sprite. The source
// has transparent padding and must not be fitted wholesale into the pet button.
const scale = (454 / 512 * 170) / 449;
export const arrivalLayout = {
  width: arrival.width * scale, height: arrival.height * scale,
  left: 29 / 512 * 170 - 86 * scale,
  top: 480 / 512 * 170 - 541 * scale,
};

const frame = (index: number): SpriteFrame => ({ src: arrival.atlas, columns: 8, rows: 14,
  frame: index, offsetY: 0, tileWidth: 480, tileHeight: 320 });
export const arrivalSequence: FrameSequence = {
  id: "arrival", src: arrival.atlas, loop: false,
  frames: Array.from({ length: arrival.frameCount }, (_, i) => i),
  durations: Array.from({ length: arrival.frameCount }, () => 40), frame,
  initialPoster: frame(0),
  poster: { src: arrival.poster, columns: 1, rows: 1, frame: 0, offsetY: 0, tileWidth: 960, tileHeight: 640 },
};
