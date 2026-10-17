import { useEffect, useState } from "react";
import type { Motion } from "./animation.js";
import { animationSpec } from "./animation.js";
export function PochiSprite({ motion, reducedMotion, onComplete }: {
  motion: Motion; reducedMotion: boolean; onComplete(token: number): void;
}) {
  const [entering, setEntering] = useState(true), [failed, setFailed] = useState(false);
  const spec = animationSpec(motion.id);
  useEffect(() => { const timer = setTimeout(() => setEntering(false), 1300); return () => clearTimeout(timer); }, []);
  useEffect(() => {
    setFailed(false); let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const image = new Image(); let started = false;
    const begin = () => {
      if (cancelled || started) return; started = true;
      // Like the HTML, idle/welcome/reminder/record stay animated until the next pose.
      if (!spec.loop) timer = setTimeout(() => { if (!cancelled) onComplete(motion.token); }, reducedMotion ? 0 : spec.durations.reduce((a, b) => a + b, 0));
    };
    image.onload = begin; image.onerror = () => { if (!cancelled) { setFailed(true); begin(); } };
    image.src = spec.gifSrc;
    if (image.complete && image.naturalWidth > 0) begin();
    return () => { cancelled = true; clearTimeout(timer); image.onload = image.onerror = null; };
  }, [motion.id, motion.token, reducedMotion, onComplete]);
  const poster = motion.id === "rest" || motion.id === "sit_to_rest" ? "rest" : "idle";
  return <img key={`${motion.token}:${motion.token === 0 && entering}`} className={`dog${entering && motion.token === 0 && !reducedMotion ? " run" : ""}`} src={failed || reducedMotion ? `/pet/pochi/${poster}-poster.png` : spec.gifSrc} alt="ポチ" draggable={false} />;
}
