import { useEffect, useState } from "react";
import type { Motion } from "./animation.js";
import { animationSpec, frameAt } from "./animation.js";
import { gifForMotion } from "./gifPresentation.js";
export function PochiSprite({ motion, reducedMotion, onComplete }: {
  motion: Motion; reducedMotion: boolean; onComplete(token: number): void;
}) {
  const [frame, setFrame] = useState(0);
  const [failed, setFailed] = useState(false);
  const spec = animationSpec(motion.id);
  const gif = gifForMotion(motion.id);
  useEffect(() => {
    let cancelled = false, handle = 0;
    let start = 0, started = false;
    setFrame(reducedMotion ? spec.frames[spec.count - 1] : spec.frames[0]); setFailed(false);
    const run = (now: number) => {
      if (cancelled) return;
      const step = frameAt(motion.id, now - start); setFrame(step.frame);
      if (step.done || reducedMotion) {
        if (!spec.loop || motion.id === "sit_to_rest") onComplete(motion.token);
      } else handle = requestAnimationFrame(run);
    };
    const begin = () => { if (cancelled || started) return; started = true; start = performance.now(); handle = requestAnimationFrame(run); };
    const image = new Image(); image.onload = begin;
    image.onerror = () => { if (!cancelled) { setFailed(true); begin(); } };
    image.src = gif ?? spec.src;
    if (image.complete && image.naturalWidth > 0) begin();
    return () => { cancelled = true; cancelAnimationFrame(handle); image.onerror = null; image.onload = null; };
    // A playback token identifies one uninterrupted segment of a sequence.
  }, [motion.id, motion.token, reducedMotion, onComplete]);
  const poster = motion.id === "rest" || motion.id === "sit_to_rest" ? "rest" : "idle";
  // GIF の内蔵 loop は業務遷移に使わず、上の main の frameAt と再生トークンで終了する。
  // 伏せへの逆再生は GIF を代用せず、従来の PNG アトラスを使う。
  const hit = { "data-hit-src": spec.src, "data-hit-columns": spec.columns, "data-hit-rows": spec.rows, "data-hit-frame": frame };
  return failed || reducedMotion ? <img className="dog" src={`/pet/pochi/${poster}-poster.png`} data-hit-src={`/pet/pochi/${poster}-poster.png`} alt="ポチ" draggable={false} />
    : gif ? <img key={motion.token} className="dog" src={gif} {...hit} alt="ポチ" draggable={false} />
    : <span className="dog" {...hit} role="img" aria-label="ポチ" style={{
      backgroundImage: `url(${spec.src})`, backgroundSize: `${spec.columns * 100}% ${spec.rows * 100}%`,
      backgroundPosition: `${frame % spec.columns / (spec.columns - 1) * 100}% ${Math.floor(frame / spec.columns) / (spec.rows - 1) * 100}%`,
    }} />;
}
