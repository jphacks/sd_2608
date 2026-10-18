import { useEffect } from "react";
import type { Motion } from "./animation.js";
import { motionSequence, spriteSize } from "./spritePlayback.js";
import { useSpriteCanvas } from "./useSpriteCanvas.js";

export function PochiSprite({ motion, reducedMotion, onComplete, onReady, onUnavailable }: {
  motion: Motion; reducedMotion: boolean; onComplete(token: number): void; onReady?(): void; onUnavailable?(): void;
}) {
  const { canvas, playback } = useSpriteCanvas(onComplete, onReady, onUnavailable);
  useEffect(() => { playback.current?.setSequence(motionSequence(motion), motion.token, reducedMotion); }, [motion, reducedMotion, playback]);
  return <canvas ref={canvas} className="dog" width={spriteSize} height={spriteSize} role="img" aria-label="ポチ">ポチ</canvas>;
}
