import type { FaceInput } from "../../contracts/domain.js";
import type { ManualFaceCapture } from "../../ports/FaceCapture.js";

export interface Detector { detect(video: HTMLVideoElement, timestamp: number): boolean; close(): void }
export interface CameraDependencies {
  getUserMedia(): Promise<MediaStream>;
  createVideo(): HTMLVideoElement;
  loadDetector(): Promise<Detector>;
  now(): number;
  monotonic(): number;
  after(milliseconds: number, callback: () => void): () => void;
}
type Run = {
  trackingId: string; sequence: number; submit: (input: FaceInput) => Promise<boolean>;
  stream?: MediaStream; video?: HTMLVideoElement; detector?: Detector;
  abort: AbortController; cleanups: (() => void)[]; timer?: () => void;
  lastVideoTime: number; lastFrameAt: number; failed: boolean;
  sending: Promise<boolean> | null;
};
const SAMPLE_MS = 1_000;
const FRAME_TIMEOUT_MS = 5_000;

/** 取得・検出・タイマーは一世代に閉じる。映像・検出座標を保持/送信しない。 */
export class FaceDetectionController implements ManualFaceCapture {
  private run: Run | null = null;
  private manualFaceDetected = false;
  constructor(private readonly dependencies: CameraDependencies, private readonly source: "camera" | "manual" = "camera") {}
  start(trackingId: string, submit: Run["submit"]): void {
    this.stop();
    const run: Run = { trackingId, submit, sequence: 0, abort: new AbortController(), cleanups: [],
      lastVideoTime: -1, lastFrameAt: this.dependencies.monotonic(), failed: false, sending: null };
    this.run = run;
    this.manualFaceDetected = false;
    if (this.source === "manual") void this.tick(run);
    else void this.open(run);
  }
  setFaceDetected(value: boolean): void { this.manualFaceDetected = value; }
  private current(run: Run): boolean { return this.run === run && !run.abort.signal.aborted; }
  stop(): void {
    const run = this.run;
    this.run = null;
    if (run) this.release(run);
  }
  private release(run: Run): void {
    run.abort.abort();
    run.timer?.(); run.timer = undefined;
    for (const cleanup of run.cleanups.splice(0)) { try { cleanup(); } catch { /* 残りの解放を続ける。 */ } }
    for (const track of run.stream?.getTracks() ?? []) { try { track.stop(); } catch { /* 切断済みでも残りを解放する。 */ } }
    run.stream = undefined;
    if (run.video) {
      try { run.video.pause(); } catch { /* Track の停止は上で実施済み。 */ }
      try { run.video.srcObject = null; } catch { /* 残りのリソースも解放する。 */ }
      run.video = undefined;
    }
    try { run.detector?.close(); } catch { /* 検出器の終了エラーでも停止状態を維持する。 */ } finally { run.detector = undefined; }
  }
  private wait<T>(run: Run, promise: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: T) => {
        if (settled) return; settled = true;
        cancel(); run.abort.signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => finish(new Error("cancelled"));
      const cancel = this.dependencies.after(milliseconds, () => finish(new Error("timeout")));
      run.abort.signal.addEventListener("abort", abort, { once: true });
      promise.then(value => finish(null, value), error => finish(error));
      if (run.abort.signal.aborted) abort();
    });
  }
  private async open(run: Run): Promise<void> {
    try {
      const permission = this.dependencies.getUserMedia().then(stream => {
        if (!this.current(run) || run.failed) stream.getTracks().forEach(track => track.stop());
        else run.stream = stream;
        return stream;
      });
      const stream = await this.wait(run, permission, 30_000);
      if (!this.current(run) || run.failed) return;
      const ended = () => { void this.fail(run, "deviceError"); };
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", ended);
        run.cleanups.push(() => track.removeEventListener("ended", ended));
      }
      const video = this.dependencies.createVideo();
      run.video = video; video.muted = true; video.playsInline = true; video.srcObject = stream;
      await this.wait(run, video.play(), 10_000);
      if (!this.current(run) || run.failed) return;
      const loading = this.dependencies.loadDetector().then(detector => {
        if (!this.current(run) || run.failed) detector.close(); else run.detector = detector;
        return detector;
      });
      await this.wait(run, loading, 15_000);
      if (!this.current(run) || run.failed) return;
      run.lastFrameAt = this.dependencies.monotonic();
      void this.tick(run);
    } catch (cause) {
      if (this.current(run) && !run.failed) {
        const name = cause instanceof Error ? cause.name : "";
        await this.fail(run, name === "NotAllowedError" || name === "SecurityError" ? "denied" : "deviceError");
      }
    }
  }
  private async send(run: Run, input: FaceInput): Promise<boolean> {
    if (run.sending) await run.sending;
    if (!this.current(run)) return false;
    const sending = Promise.resolve().then(() => this.current(run) && !run.failed ? run.submit(input) : false).catch(() => false);
    run.sending = sending;
    const cancelDeadline = this.dependencies.after(5_000, () => { void this.fail(run, "deviceError"); });
    run.cleanups.push(cancelDeadline);
    const accepted = await sending;
    cancelDeadline();
    run.cleanups = run.cleanups.filter(cleanup => cleanup !== cancelDeadline);
    if (run.sending === sending) run.sending = null;
    return accepted;
  }
  private async fail(run: Run, reason: "denied" | "deviceError"): Promise<void> {
    if (!this.current(run) || run.failed) return;
    run.failed = true;
    // カメラを直ちに解放する。未完了の送信があれば、その後に unavailable を一度送る。
    const pending = run.sending;
    this.release(run);
    if (pending) await pending;
    if (this.run !== run) return;
    // release は abort 済みだが、この世代の最後の unavailable だけは送る。
    try { await run.submit({ trackingId: run.trackingId, sequence: ++run.sequence,
      observedAt: this.dependencies.now(), source: this.source, kind: "unavailable", reason }); } catch { /* 再送しない。Rust の鮮度チェックでも失効する。 */ }
  }
  private async tick(run: Run): Promise<void> {
    if (!this.current(run) || run.failed) return;
    const began = this.dependencies.monotonic();
    try {
      let detected: boolean | null = null;
      if (this.source === "manual") detected = this.manualFaceDetected;
      else if (run.video && run.detector) {
        if (!run.stream?.getVideoTracks().some(track => track.readyState === "live")) { await this.fail(run, "deviceError"); return; }
        if (run.video.readyState >= 2 && run.video.currentTime !== run.lastVideoTime) {
          run.lastVideoTime = run.video.currentTime; run.lastFrameAt = began;
          detected = run.detector.detect(run.video, began);
        } else if (began - run.lastFrameAt >= FRAME_TIMEOUT_MS) { await this.fail(run, "deviceError"); return; }
      }
      if (detected !== null) {
        const accepted = await this.send(run, { trackingId: run.trackingId, sequence: ++run.sequence,
          observedAt: this.dependencies.now(), source: this.source, kind: "sample", faceDetected: detected });
        if (!accepted && this.current(run)) { await this.fail(run, "deviceError"); return; }
      }
      if (this.current(run) && !run.failed) run.timer = this.dependencies.after(Math.max(0, SAMPLE_MS - (this.dependencies.monotonic() - began)), () => { void this.tick(run); });
    } catch { await this.fail(run, "deviceError"); }
  }
}
