import { freshData, reducePochi, settleCards } from "./model.js";
import type { Command, PochiData, Settings } from "./model.js";
import { finishMotion, initialMotion, moveTo } from "./animation.js";
import type { Motion } from "./animation.js";
import type { Repository } from "./repository.js";
export type Panel = "home" | "start" | "menu" | "settings" | "reminder" | "rest" | "welcome" | "report" | "recovery" | "quiet" | "away" | "tasks" | "generating" | "ready";
export type PochiView = { data: PochiData; panel: Panel; motion: Motion; error: string;
  notice: string; message: string; closing: boolean; restingDone: boolean; paused: boolean; speed: 1 | 60 | 600; noteOpen: boolean };
export type Clock = { monotonic(): number; wall(): number };
export class PochiController {
  private listeners = new Set<() => void>();
  private view: PochiView;
  private lastMono = 0;
  private lastWall = 0;
  private lastSave = 0;
  private enabled = false;
  private logicalNow: number;
  constructor(private repository: Repository, private clock: Clock, readonly demo = false,
    private id: () => string = () => crypto.randomUUID(), private notify: (text: string, settings: Settings) => void = () => {}) {
    const { data, notice } = repository.load();
    this.logicalNow = this.clock.wall();
    this.view = { data: data ?? freshData(), panel: data.active ? "recovery" : "home", motion: initialMotion(),
      notice, message: "", error: "", closing: false, restingDone: false, paused: false, speed: demo ? 60 : 1, noteOpen: false };
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
    let data = reducePochi(this.view.data, command);
    if (data === this.view.data) return false;
    if (command.type === "yes") data = { ...data, cards: data.cards.map(c => c.status === "generating" && !this.view.data.cards.some(old => old.id === c.id)
      ? { ...c, readyAt: this.clock.wall() + 4200 } : c) };
    this.publish({ data }); this.persist(); return true;
  }
  private motion(pose: "idle" | "rest", action?: Parameters<typeof moveTo>[2]) {
    this.publish({ motion: moveTo(this.view.motion, pose, action) });
  }
  tick = () => {
    if (!this.enabled) return;
    const mono = this.clock.monotonic(), wall = this.clock.wall();
    const elapsed = mono - this.lastMono, wallElapsed = wall - this.lastWall;
    this.lastMono = mono; this.lastWall = wall;
    if (this.view.error) return;
    // Timer throttling, sleep and clock changes must not add offline hours to a session.
    if (!this.view.paused && elapsed > 0 && elapsed <= 10_000 && Math.abs(wallElapsed - elapsed) < 2_000) {
      this.logicalNow = this.demo ? this.logicalNow + elapsed * this.view.speed : wall;
      const now = this.now();
      const before = this.view.data.active?.phase;
      const data = reducePochi(this.view.data, { type: "tick", elapsedMs: elapsed * this.view.speed, now });
      if (data !== this.view.data) this.publish({ data });
      if (before === "working" && data.active?.phase === "reminder") {
        this.publish({ panel: ["settings", "report"].includes(this.view.panel) ? this.view.panel : "reminder", message: "" }); this.motion("idle", "reminder");
        this.notify("少し立って、休憩しない？", data.settings); this.persist();
      }
      const open = data.active?.breaks.find(b => b.endedAt === null);
      if (data.active?.phase === "resting" && open && !this.view.restingDone
        && open.durationMs >= data.settings.restMinutes * 60_000) {
        this.publish({ restingDone: true }); this.notify("そろそろ戻る？ 準備ができたら戻ったよを押してね。", data.settings);
      }
    }
    this.updateCards();
    if (mono - this.lastSave >= 2_000) this.persist();
  };
  private now() { return this.demo ? this.logicalNow : this.clock.wall(); }
  private updateCards() {
    const before = this.view.data.cards;
    const data = settleCards(this.view.data, this.now(), this.clock.wall());
    if (data === this.view.data) return;
    const ready = data.cards.some(c => c.status === "ready" && before.find(old => old.id === c.id)?.status !== "ready");
    const panel = ready && ["quiet", "away", "welcome", "generating"].includes(this.view.panel) && !this.view.noteOpen ? "ready" : this.view.panel;
    this.publish({ data, panel }); this.persist();
  }
  setSpeed = (speed: 1 | 60 | 600) => { if (this.demo) { this.tick(); this.publish({ speed }); } };
  demoAdvance = (milliseconds: number) => {
    if (!this.demo || this.view.error || !Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.logicalNow += milliseconds;
    this.apply({ type: "tick", elapsedMs: milliseconds, now: this.now() });
    if (this.view.data.active?.phase === "reminder") { this.publish({ panel: "reminder" }); this.motion("idle", "reminder"); }
    this.updateCards();
  };
  leave = () => { this.tick(); if (this.apply({ type: "leave", now: this.now() })) { this.publish({ panel: "away", noteOpen: false }); this.motion("rest"); } };
  finishNote = () => { this.publish({ noteOpen: false, panel: this.view.data.cards.some(c => c.session.id === this.view.data.active?.id && c.status === "ready") ? "ready" : "generating" }); };
  skipNote = () => { this.note("", ""); this.finishNote(); };
  openTasks = () => this.publish({ panel: "tasks" });
  setPaused(paused: boolean) {
    if (paused) this.tick();
    this.publish({ paused }); this.lastMono = this.clock.monotonic(); this.lastWall = this.clock.wall(); this.persist();
  }
  tap = () => {
    if (this.view.panel === "settings") return;
    const active = this.view.data.active;
    if (!active) {
      if (this.view.panel === "start") return; // The view supplies the current form draft on the second click.
      this.publish({ panel: "start", message: "" }); this.motion("idle"); return;
    }
    if (active.phase === "away" || active.phase === "resting") { this.returnToWork(); return; }
    this.motion("idle", active.phase === "reminder" ? "reminder" : "record");
    this.publish({ panel: active.phase === "recovered" ? "recovery" : active.phase === "reminder" ? "reminder" : "menu", message: "" });
  };
  start(task: string, kind: "work" | "study") {
    this.tick();
    if (this.apply({ type: "start", task, kind, id: this.id(), now: this.now() })) {
      this.publish({ panel: "quiet", message: `${new Date(this.now()).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} に開始を記録したよ。いっしょにがんばろう`, closing: false }); this.motion("rest");
    }
  }
  accept = () => {
    this.tick();
    if (this.apply({ type: "yes", now: this.now(), reason: this.view.data.active?.phase === "reminder" ? "reminder" : "manual" })) {
      this.publish({ panel: "generating", restingDone: false, message: "", noteOpen: true }); this.motion("rest");
    }
  };
  decline = () => {
    this.tick();
    if (this.apply({ type: "no", now: this.now() })) {
      this.publish({ panel: "quiet", message: "わかったよ。休憩も忘れないでね。あとでまた声をかけるよ。" }); this.motion("rest");
    }
  };
  note(progress: string, problem: string) { this.apply({ type: "note", progress, problem, now: this.now() }); }
  returnToWork = () => {
    this.tick();
    if (this.apply({ type: "return", now: this.now() })) {
      this.publish({ panel: "welcome", message: "", noteOpen: false }); this.motion("idle", "welcome");
    }
  };
  resume = () => {
    if (this.apply({ type: "resume", now: this.now() })) { this.publish({ panel: "quiet" }); this.motion("rest"); }
  };
  continueWork = () => { this.publish({ panel: "quiet", message: "いっしょに、少しずつ。" }); this.motion("rest"); };
  turn = () => { if (this.view.data.active && this.view.data.active.phase !== "working") return; this.motion("idle", "turn_sit"); };
  completeAnimation = (token: number) => { const motion = finishMotion(this.view.motion, token); if (motion !== this.view.motion) this.publish({ motion }); };
  openSettings = () => { this.motion("idle", "record"); this.publish({ panel: "settings", message: "" }); };
  saveSettings(settings: Settings) {
    this.tick(); this.apply({ type: "settings", settings, now: this.now() });
    this.closePanel();
  }
  closePanel = () => {
    const phase = this.view.data.active?.phase;
    if (phase && phase !== "reminder" && phase !== "recovered") this.motion("rest");
    else this.motion("idle", phase === "reminder" ? "reminder" : undefined);
    this.publish({ panel: phase === "reminder" ? "reminder" : phase === "resting" ? "rest" : phase === "away" ? "away" : phase === "recovered" ? "recovery" : phase ? "quiet" : "home" });
  };
  openReports = () => { this.motion("idle", "record"); this.publish({ panel: "report" }); };
  end = (closing = false) => {
    this.tick(); this.apply({ type: "end", now: this.now() });
    this.publish({ panel: "report", closing, message: "" }); this.motion("idle"); return this.persist();
  };
  checkpoint = () => this.persist();
  pageHide = () => { this.end(); this.repository.release(); };
}
