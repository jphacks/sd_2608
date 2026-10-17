import type { PetManifest } from "../contracts/presentation.js";

export const petPosters = { sit: "/pet/placeholder-sit.svg", lie: "/pet/placeholder-lie.svg" } as const;

/** 仮素材。GIF の完成後は src と実際の durationMs をこのファイルで変更する。 */
export const petManifest = {
  launch: { src: petPosters.sit, poster: petPosters.sit, durationMs: 600, loop: false, finalPose: "sit" },
  runIn: { src: petPosters.sit, poster: petPosters.sit, durationMs: 1_200, loop: false, finalPose: "sit" },
  welcome: { src: petPosters.sit, poster: petPosters.sit, durationMs: 1_500, loop: false, finalPose: "sit" },
  idleRest: { src: petPosters.lie, poster: petPosters.lie, durationMs: 2_000, loop: true, finalPose: "lie" },
  recordReminder: { src: petPosters.sit, poster: petPosters.sit, durationMs: 1_500, loop: false, finalPose: "sit" },
  sitToLie: { src: petPosters.lie, poster: petPosters.lie, durationMs: 800, loop: false, finalPose: "lie" },
  lieToSit: { src: petPosters.sit, poster: petPosters.sit, durationMs: 800, loop: false, finalPose: "sit" },
} satisfies PetManifest;
