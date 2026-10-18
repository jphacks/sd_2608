import { useEffect } from "react";
import { arrival, arrivalLayout, arrivalSequence } from "./startup.js";
import { releaseSpriteImage, useSpriteCanvas } from "./useSpriteCanvas.js";

export function PochiArrival({ reducedMotion, leaving, onComplete }: {
  reducedMotion: boolean; leaving: boolean; onComplete(): void;
}) {
  const { canvas, playback } = useSpriteCanvas(onComplete);
  useEffect(() => { playback.current?.setSequence(arrivalSequence, 0, reducedMotion); }, [reducedMotion, playback]);
  useEffect(() => () => releaseSpriteImage(arrival.atlas), []);
  return <span className={`arrival-layer${leaving ? " leaving" : ""}`} aria-hidden="true">
    <canvas ref={canvas} className="arrival-dog" width={480} height={320} style={arrivalLayout} />
  </span>;
}
