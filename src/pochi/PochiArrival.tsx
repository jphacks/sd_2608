import { useEffect, useRef, useState } from "react";
import { arrival, arrivalLayout, ArrivalPlayback } from "./startup.js";

export function PochiArrival({ reducedMotion, leaving, onComplete }: {
  reducedMotion: boolean; leaving: boolean; onComplete(): void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const playback = new ArrivalPlayback(onComplete, (callback, delay) => {
      const timer = setTimeout(callback, delay); return () => clearTimeout(timer);
    });
    const element = image.current;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fail = () => { clearTimeout(timeout); setFailed(true); playback.skip(); };
    const loaded = () => { clearTimeout(timeout); playback.loaded(); };
    if (reducedMotion) playback.skip();
    else if (element) {
      element.addEventListener("load", loaded); element.addEventListener("error", fail);
      // A missing/stalled asset must not leave the app locked on its entrance.
      timeout = setTimeout(fail, 15_000);
      if (element.complete) { if (element.naturalWidth) loaded(); else fail(); }
    }
    return () => {
      playback.dispose(); clearTimeout(timeout);
      element?.removeEventListener("load", loaded); element?.removeEventListener("error", fail);
    };
  }, [reducedMotion, onComplete]);
  return <span className={`arrival-layer${leaving ? " leaving" : ""}`} aria-hidden="true">
    <img ref={image} className="arrival-dog" style={arrivalLayout} data-hit-src={arrival.poster}
      src={reducedMotion || failed ? arrival.poster : arrival.src} alt="" draggable={false} />
  </span>;
}
