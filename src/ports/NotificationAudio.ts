import type { NotificationSound } from "../contracts/domain.js";

export interface NotificationAudio {
  play(sound: NotificationSound): void;
  stop(): void;
}
