import references from "./reference-gifs.json" with { type: "json" };
import type { ActionId } from "./animation.js";

/** 素材の対応だけを定義。時間・loop・遷移・逆再生は main の animation.ts を使う。 */
export function gifForMotion(id: ActionId): string | null {
  return id === "sit_to_rest" ? null : references[id].src;
}
