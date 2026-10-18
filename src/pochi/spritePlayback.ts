import { animationSpec, frameAt } from "./animation.js";
import type { ActionId, Motion } from "./animation.js";
import registration from "./frame-registration.json" with { type: "json" };

export const spriteSize = 512;
export type SpriteFrame = {
  src: string; columns: number; rows: number; frame: number; offsetY: number;
};

/** 元絵の横方向の動きを残し、足元だけを共通の接地線へ合わせる。 */
export function spriteFrame(id: ActionId, frame: number): SpriteFrame {
  const spec = animationSpec(id);
  const bottoms = registration[id === "sit_to_rest" ? "rest_to_sit" : id];
  return { src: spec.src, columns: spec.columns, rows: spec.rows, frame, offsetY: 480 - bottoms[frame] };
}

function posterFrame(id: ActionId): SpriteFrame {
  const pose = id === "rest" || id === "sit_to_rest" ? "rest" : "idle";
  return { ...spriteFrame(pose, 0), src: `/pet/pochi/${pose}-poster.png`, columns: 1, rows: 1, frame: 0 };
}

export interface SpritePlaybackPorts<Image> {
  load(src: string): Promise<Image>;
  paint(image: Image, frame: SpriteFrame): void;
  complete(token: number): void;
  now(): number;
  request(callback: (now: number) => void): number;
  cancel(handle: number): void;
}

/** 描画と完了通知を一つの時計で管理。画像の読込中は直前の画面を保持する。 */
export class SpritePlayback<Image> {
  private generation = 0;
  private key = "";
  private handle: number | null = null;
  private hidden = false;
  private disposed = false;
  private hasPainted = false;
  private tick: ((now: number) => void) | null = null;
  private previousTime = 0;

  constructor(private readonly ports: SpritePlaybackPorts<Image>) {}

  setMotion(motion: Motion, reduced: boolean): void {
    if (this.disposed) return;
    this.prefetch(motion);
    // キューの更新だけでは、再生中の姿勢遷移を最初からやり直さない。
    const key = `${motion.id}:${motion.token}:${reduced}`;
    if (this.key === key) return;
    this.key = key;
    this.stopFrame();
    this.tick = null;
    const generation = ++this.generation;
    const current = () => !this.disposed && generation === this.generation;
    const spec = animationSpec(motion.id);
    const once = !spec.loop;
    const poster = posterFrame(motion.id);
    const paint = (image: Image, frame: SpriteFrame) => {
      if (!current()) return;
      this.ports.paint(image, frame);
      this.hasPainted = true;
    };
    const finishStatic = () => {
      if (!once || !current()) return;
      this.tick = () => {
        if (!current()) return;
        this.tick = null;
        this.ports.complete(motion.token);
      };
      this.schedule();
    };
    // 初回のみ軽量のポスターを先に表示。遅れて届いても動画を上書きしない。
    if (!this.hasPainted && !reduced) {
      const initialPoster = posterFrame(motion.id === "rest_to_sit" ? "rest" : motion.id === "sit_to_rest" ? "idle" : motion.id);
      void this.ports.load(initialPoster.src).then(image => {
        if (!this.hasPainted) paint(image, initialPoster);
      }).catch(() => {});
    }
    const source = reduced ? poster.src : spec.src;
    void this.ports.load(source).then(image => {
      if (!current()) return;
      if (reduced) { paint(image, poster); finishStatic(); return; }
      let elapsed = 0, paintedFrame = spec.frames[0];
      paint(image, spriteFrame(motion.id, paintedFrame));
      this.previousTime = this.ports.now();
      this.tick = now => {
        if (!current()) return;
        // OS の一時停止・重い処理の後に中間ポーズを一気に飛ばさない。
        elapsed += Math.min(100, Math.max(0, now - this.previousTime));
        this.previousTime = now;
        const step = frameAt(motion.id, elapsed);
        if (step.frame !== paintedFrame) {
          paintedFrame = step.frame;
          paint(image, spriteFrame(motion.id, step.frame));
        }
        if (step.done) {
          this.tick = null;
          this.ports.complete(motion.token);
        } else this.schedule();
      };
      this.schedule();
    }).catch(async () => {
      if (!current()) return;
      try { paint(await this.ports.load(poster.src), poster); } catch { /* 直前の描画を保持 */ }
      finishStatic();
    });
  }

  setHidden(hidden: boolean): void {
    if (this.disposed || this.hidden === hidden) return;
    this.hidden = hidden;
    this.stopFrame();
    if (!hidden) { this.previousTime = this.ports.now(); this.schedule(); }
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.stopFrame();
    this.tick = null;
  }

  private prefetch(motion: Motion): void {
    for (const id of [motion.queue[0], motion.after]) {
      if (id) void this.ports.load(animationSpec(id).src).catch(() => {});
    }
  }

  private schedule(): void {
    if (this.hidden || this.disposed || !this.tick || this.handle !== null) return;
    const generation = this.generation;
    this.handle = this.ports.request(now => {
      if (generation !== this.generation) return;
      this.handle = null;
      if (!this.hidden && !this.disposed) this.tick?.(now);
    });
  }

  private stopFrame(): void {
    if (this.handle !== null) this.ports.cancel(this.handle);
    this.handle = null;
  }
}
