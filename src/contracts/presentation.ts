import type { DurationMs, Id } from "./domain.js";

export type PetAnimationId =
  | "launch" | "runIn" | "welcome" | "idleRest"
  | "recordReminder" | "sitToLie" | "lieToSit";
export type PetPose = "sit" | "lie";
export type AnimationAsset = {
  src: string;
  poster: string;
  durationMs: DurationMs;
  loop: boolean;
  finalPose: PetPose;
};
export type PetManifest = Record<PetAnimationId, AnimationAsset>;
export type PetViewModel = {
  pose: PetPose;
  animation: PetAnimationId | null;
  playbackToken: Id;
  greeting: string | null;
  statusText: string;
};
export type BubbleViewModel = {
  reminderId: Id;
  text: string;
  emphasis: "normal" | "hard";
  yesLabel: string;
  noLabel: string;
  disabled: boolean;
};
