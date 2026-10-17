import atlasData from "./atlases.json" with { type: "json" };
import referenceGifs from "./reference-gifs.json" with { type: "json" };
export type ActionId = keyof typeof atlasData | "sit_to_rest";
export type Pose = "idle" | "rest";
export function animationSpec(id: ActionId) {
  // Preserve the supplied HTML's POSE table, including A06 -> turn_sit (3320ms).
  const name = id === "sit_to_rest" ? "turn_sit" : id;
  const base = atlasData[name];
  return { ...base, gifSrc: referenceGifs[name].src,
    loop: !["sit_to_rest", "rest_to_sit", "turn_sit"].includes(id),
    durations: base.durations, frames: Array.from({ length: base.count }, (_, i) => i) };
}
export function frameAt(id: ActionId, elapsedMs: number): { frame: number; done: boolean } {
  const spec = animationSpec(id), total = spec.durations.reduce((a, b) => a + b, 0);
  let time = Math.max(0, elapsedMs);
  if (spec.loop && id !== "sit_to_rest") time %= total;
  else if (time >= total) return { frame: spec.frames[spec.count - 1], done: true };
  for (let i = 0; i < spec.count; i++) {
    if (time < spec.durations[i]) return { frame: spec.frames[i], done: false };
    time -= spec.durations[i];
  }
  return { frame: spec.frames[spec.count - 1], done: false };
}
export type Motion = { id: ActionId; token: number; queue: ActionId[]; after: Pose };
export const initialMotion = (): Motion => ({ id: "idle", token: 0, queue: [], after: "idle" });
/** Finish an in-flight pose transition before reversing it; other short actions can be interrupted. */
export function moveTo(current: Motion, pose: Pose, action?: ActionId): Motion {
  const tail = action ? [action] : [];
  if (pose === "rest") {
    if (current.id === "rest_to_sit") return { ...current, queue: ["sit_to_rest"], after: "rest" };
    if (current.id === "sit_to_rest") return { ...current, queue: [], after: "rest" };
    return { id: current.id === "rest" ? "rest" : "sit_to_rest", token: current.token + 1, queue: [], after: "rest" };
  }
  if (current.id === "sit_to_rest") return { ...current, queue: ["rest_to_sit", ...tail], after: "idle" };
  if (current.id === "rest_to_sit") return { ...current, queue: tail, after: "idle" };
  const sequence: ActionId[] = current.id === "rest" ? ["rest_to_sit", ...tail] : tail;
  return { id: sequence[0] ?? "idle", token: current.token + 1, queue: sequence.slice(1), after: "idle" };
}
export function finishMotion(current: Motion, token: number): Motion {
  if (current.token !== token) return current;
  return { ...current, id: current.queue[0] ?? current.after, queue: current.queue.slice(1), token: current.token + 1 };
}
