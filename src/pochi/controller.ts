import { freshData, reducePochi } from "./model.js";
import type { Command, PochiData, Settings } from "./model.js";
import { finishMotion, initialMotion, moveTo } from "./animation.js";
import type { Motion } from "./animation.js";
import type { Repository } from "./repository.js";
export type Panel = "home" | "start" | "menu" | "settings" | "reminder" | "rest" | "welcome" | "report" | "recovery" | "quiet";
export type PochiView = { data: PochiData; panel: Panel; motion: Motion; error: string;
  notice: string; message: string; closing: boolean; restingDone: boolean; paused: boolean };
export type Clock = { monotonic(): number; wall(): number };
export class PochiController {
  private listeners = new Set<() => void>();
  private view: PochiView;
  private lastMono = 0;
  private lastWall = 0;
  private lastSave = 0;
  private enabled = false;
  constructor(private repository: Repository, private clock: Clock, readonly demo = false,
    private id: () => string = () => crypto.randomUUID(), private notify: (text: string, settings: Settings) => void = () => {}) {
    const { data, notice } = repository.load();
    this.view = { data: data ?? freshData(), panel: data.active ? "recovery" : "home", motion: initialMotion(),
      notice, message: "", error: "", closing: false, restingDone: false, paused: false };
  }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  getSnapshot = () => this.view;
  private publish(next: Partial<PochiView>) { this.view = { ...this.view, ...next }; this.listeners.forEach(fn => fn()); }
  private persist(): boolean {
    try { this.repository.save(this.view.data); this.lastSave = this.clock.monotonic(); if (this.view.error) this.publish({ error: "" }); return true; }
    catch (error) { this.publish({ error: error instanceof Error ? error.message : "記録を保存できません。保存領域を確認してください。" }); return false; }
  }
  mount() {
    this.enabled = true; this.lastMono = this.clock.monotonic(); this.lastWall = this.clock.wall();
    this.persist();
  }
  unmount() { this.enabled = false; this.repository.release(); }
  private apply(command: Command) {
    if (this.view.error) return false;
    const data = reducePochi(this.view.data, command, this.demo);
    if (data === this.view.data) return false;
    this.publish({ data }); this.persist(); return true;
  }
  private motion(pose: "idle" | "rest", action?: Parameters<typeof moveTo>[2]) {
    this.publish({ motion: moveTo(this.view.motion, pose, action) });
  }
  tick = () => {
    if (!this.enabled) return;
    const mono = this.clock.monotonic(), now = this.clock.wall();
    const elapsed = mono - this.lastMono, wallElapsed = now - this.lastWall;
    this.lastMono = mono; this.lastWall = now;
    if (this.view.error) return;
    // Timer throttling, sleep and clock changes must not add offline hours to a session.
    if (!this.view.paused && elapsed > 0 && elapsed <= 10_000 && Math.abs(wallElapsed - elapsed) < 2_000) {
      const before = this.view.data.active?.phase;
      const data = reducePochi(this.view.data, { type: "tick", elapsedMs: elapsed, now }, this.demo);
      if (data !== this.view.data) this.publish({ data });
      if (before === "working" && data.active?.phase === "reminder") {
        this.publish({ panel: ["settings", "report"].includes(this.view.panel) ? this.view.panel : "reminder", message: "" }); this.motion("idle", "reminder");
        this.notify("少し立って、休憩しない？", data.settings); this.persist();
      }
      const open = data.active?.breaks.find(b => b.endedAt === null);
      if (data.active?.phase === "resting" && open && !this.view.restingDone
        && open.durationMs >= (this.demo ? 8_000 : data.settings.restMinutes * 60_000)) {
        this.publish({ restingDone: true }); this.notify("そろそろ戻る？ 準備ができたら戻ったよを押してね。", data.settings);
      }
    }
    if (mono - this.lastSave >= 2_000) this.persist();
  };
  setPaused(paused: boolean) {
    if (paused) this.tick();
    this.publish({ paused }); this.lastMono = this.clock.monotonic(); this.lastWall = this.clock.wall(); this.persist();
  }
  tap = () => {
    if (this.view.panel === "settings") return;
    const active = this.view.data.active;
    if (!active) {
      if (this.view.panel === "start") return; // The view supplies the current form draft on the second click.
      this.publish({ panel: "start", message: "" }); this.motion("idle", "record"); return;
    }
    this.publish({ panel: active.phase === "recovered" ? "recovery" : active.phase === "reminder" ? "reminder"
      : active.phase === "resting" ? "rest" : "menu", message: "" });
  };
  start(task: string, kind: "work" | "study") {
    this.tick();
    if (this.apply({ type: "start", task, kind, id: this.id(), now: this.clock.wall() })) {
      this.publish({ panel: "quiet", message: "記録をはじめたよ。ここで待ってるね。", closing: false }); this.motion("rest");
    }
  }
  accept = () => {
    this.tick();
    if (this.apply({ type: "yes", now: this.clock.wall(), reason: this.view.data.active?.phase === "reminder" ? "reminder" : "manual" })) {
      this.publish({ panel: "rest", restingDone: false, message: "" }); this.motion("rest");
    }
  };
  decline = () => {
    this.tick();
    if (this.apply({ type: "no", now: this.clock.wall() })) {
      this.publish({ panel: "quiet", message: "わかったよ。休憩も忘れないでね。あとでまた声をかけるよ。" }); this.motion("rest");
    }
  };
  note(progress: string, problem: string) { this.apply({ type: "note", progress, problem, now: this.clock.wall() }); }
  returnToWork = () => {
    this.tick();
    if (this.apply({ type: "return", now: this.clock.wall() })) {
      this.publish({ panel: "welcome", message: "" }); this.motion("idle", "welcome");
    }
  };
  resume = () => {
    if (this.apply({ type: "resume", now: this.clock.wall() })) { this.publish({ panel: "quiet" }); this.motion("rest"); }
  };
  continueWork = () => { this.publish({ panel: "quiet", message: "いっしょに、少しずつ。" }); this.motion("rest"); };
  turn = () => { if (this.view.data.active && this.view.data.active.phase !== "working") return; this.motion("idle", "turn_sit"); };
  completeAnimation = (token: number) => { const motion = finishMotion(this.view.motion, token); if (motion !== this.view.motion) this.publish({ motion }); };
  openSettings = () => this.publish({ panel: "settings", message: "" });
  saveSettings(settings: Settings) {
    this.tick(); this.apply({ type: "settings", settings, now: this.clock.wall() });
    this.closePanel();
  }
  closePanel = () => {
    const phase = this.view.data.active?.phase;
    this.publish({ panel: phase === "reminder" ? "reminder" : phase === "resting" ? "rest" : phase === "recovered" ? "recovery" : phase ? "quiet" : "home" });
  };
  openReports = () => this.publish({ panel: "report" });
  end = (closing = false) => {
    this.tick(); this.apply({ type: "end", now: this.clock.wall() });
    this.publish({ panel: "report", closing, message: "" }); this.motion("idle"); return this.persist();
  };
  checkpoint = () => this.persist();
  pageHide = () => { this.end(); this.repository.release(); };
}
