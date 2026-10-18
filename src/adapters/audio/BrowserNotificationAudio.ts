import type { NotificationSound } from "../../contracts/domain.js";
import type { NotificationAudio } from "../../ports/NotificationAudio.js";

const sources = { dog: "/sounds/dog.mp3", system: "/sounds/system.mp3" } as const;
type AudioPlayer = Pick<HTMLAudioElement, "play" | "pause" | "currentTime">;

export class BrowserNotificationAudio implements NotificationAudio {
  private current: AudioPlayer | null = null;

  constructor(private readonly createAudio: (source: string) => AudioPlayer = source => new Audio(source)) {}

  play(sound: NotificationSound): void {
    this.stop();
    if (sound === "none") return;
    try {
      const audio = this.createAudio(sources[sound]);
      this.current = audio;
      // 再生制限や出力デバイスの不調があっても、通知と記録は続ける。
      void audio.play().catch(() => { if (this.current === audio) this.stop(); });
    } catch { this.stop(); }
  }

  stop(): void {
    const audio = this.current;
    this.current = null;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }
}
