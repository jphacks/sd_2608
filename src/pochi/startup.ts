/** Approved short-distance v3: 107 transparent frames, played once per app mount. */
export const arrival = {
  src: "/pet/pochi/startup/run-in-prone.png",
  poster: "/pet/pochi/startup/final-frame.png",
  width: 960, height: 640, frameCount: 107, durationMs: 4280,
} as const;

// Match the final visible dog to the existing 170px resting sprite. The source
// has transparent padding and must not be fitted wholesale into the pet button.
const scale = (454 / 512 * 170) / 449;
export const arrivalLayout = {
  width: arrival.width * scale, height: arrival.height * scale,
  left: 29 / 512 * 170 - 86 * scale,
  top: 480 / 512 * 170 - 541 * scale,
};

type Schedule = (callback: () => void, delayMs: number) => () => void;
/** Loading is separate from playback; cleanup also cancels late events. */
export class ArrivalPlayback {
  private started = false;
  private finished = false;
  private cancel = () => {};
  constructor(private complete: () => void, private schedule: Schedule) {}
  loaded() {
    if (this.started || this.finished) return;
    this.started = true;
    this.cancel = this.schedule(() => this.skip(), arrival.durationMs);
  }
  skip() {
    if (this.finished) return;
    this.finished = true; this.cancel(); this.complete();
  }
  dispose() { this.finished = true; this.cancel(); }
}
