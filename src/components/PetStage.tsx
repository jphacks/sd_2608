import { useEffect, useState } from "react";
import type { PetStageProps } from "../contracts/ui.js";
import type { PetAnimationId } from "../contracts/presentation.js";
import { petPosters } from "../presentation/petManifest.js";

/** GIF 制御の最小サンプル。終了時間・割り込み・静止画への代替を確認できる。 */
export function PetStage({ pet, manifest, reducedMotion, onClick }: PetStageProps) {
  const [playing, setPlaying] = useState<PetAnimationId | null>(pet.animation);
  useEffect(() => {
    if (reducedMotion) { setPlaying(null); return; }
    setPlaying(pet.animation);
    if (!pet.animation || manifest[pet.animation].loop) return;
    const timer = setTimeout(() => setPlaying(null), manifest[pet.animation].durationMs);
    return () => clearTimeout(timer);
  }, [pet.playbackToken, pet.animation, manifest, reducedMotion]);
  const asset = playing ? manifest[playing] : null;
  const finishedAsset = pet.animation ? manifest[pet.animation] : null;
  const fallback = asset?.poster ?? (finishedAsset ? petPosters[finishedAsset.finalPose] : petPosters[pet.pose]);
  return <div className="pet-stage">
    {pet.greeting && <p>{pet.greeting}</p>}
    <button className="pet-stage__button" onClick={onClick} aria-label="最新のレポートを開く">
      <img key={`${pet.playbackToken}-${playing}`} src={asset?.src ?? fallback} alt="休憩のおとも" width="240" height="240"
        onError={event => { const image = event.currentTarget; image.onerror = null; if (!image.src.endsWith(fallback)) image.src = fallback; }} />
    </button>
    <p>{pet.statusText}</p>
  </div>;
}
