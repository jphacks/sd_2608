/** Manual workflow. Independent of the sensor/AI IPC contracts. All durations are milliseconds. */
export type Phase = "working" | "reminder" | "resting" | "recovered";
export type Settings = { remindMinutes: number; restMinutes: number; snoozeMinutes: number;
  petSize: number; alwaysOnTop: boolean; reducedMotion: boolean; sound: "chime" | "voice" | "silent" };
export type BreakRecord = { startedAt: number; endedAt: number | null; durationMs: number;
  workCheckpointMs: number; progress: string; problem: string; reason: "manual" | "reminder" };
export type Session = { id: string; task: string; kind: "work" | "study"; startedAt: number;
  updatedAt: number; endedAt: number | null; phase: Phase; workMs: number; restMs: number;
  nextReminderWorkMs: number; breaks: BreakRecord[];
  reminders: { at: number; choice: "pending" | "yes" | "no" | "ended" | "interrupted" }[] };
export type PochiData = { version: 1; settings: Settings; active: Session | null; history: Session[] };
export const defaults: Settings = { remindMinutes: 30, restMinutes: 10, snoozeMinutes: 10,
  petSize: 230, alwaysOnTop: true, reducedMotion: false, sound: "chime" };
export const freshData = (): PochiData => ({ version: 1, settings: { ...defaults }, active: null, history: [] });
export function checkedSettings(input: Settings): Settings {
  const integer = (n: number, min: number, max: number) => Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max;
  if (!integer(input.remindMinutes, 1, 180) || !integer(input.restMinutes, 1, 60)
    || !integer(input.snoozeMinutes, 1, 120) || !integer(input.petSize, 150, 300)
    || typeof input.alwaysOnTop !== "boolean" || typeof input.reducedMotion !== "boolean"
    || !["chime", "voice", "silent"].includes(input.sound)) throw new Error("設定の入力範囲を確認してください。");
  return { ...input };
}
export type Command =
  | { type: "start"; id: string; task: string; kind: "work" | "study"; now: number }
  | { type: "tick"; elapsedMs: number; now: number }
  | { type: "yes"; now: number; reason: "manual" | "reminder" }
  | { type: "no"; now: number }
  | { type: "note"; progress: string; problem: string; now: number }
  | { type: "return" | "resume" | "end"; now: number }
  | { type: "settings"; settings: Settings; now: number };
const clean = (s: string, max: number) => s.trim().slice(0, max);
export function reducePochi(data: PochiData, command: Command, demo = false): PochiData {
  const interval = (settings: Settings) => demo ? 12_000 : settings.remindMinutes * 60_000;
  if (command.type === "settings") {
    const settings = checkedSettings(command.settings);
    const active = data.active && { ...data.active };
    if (active?.phase === "working" && settings.remindMinutes !== data.settings.remindMinutes)
      active.nextReminderWorkMs = active.workMs + interval(settings);
    return { ...data, settings, active };
  }
  if (command.type === "start") {
    if (data.active) return data;
    const session: Session = { id: command.id, task: clean(command.task, 120), kind: command.kind,
      startedAt: command.now, updatedAt: command.now, endedAt: null, phase: "working",
      workMs: 0, restMs: 0, nextReminderWorkMs: interval(data.settings), breaks: [], reminders: [] };
    return { ...data, active: session };
  }
  if (!data.active) return data;
  const s: Session = { ...data.active, breaks: data.active.breaks.map(b => ({ ...b })),
    reminders: data.active.reminders.map(r => ({ ...r })) };
  const open = s.breaks.find(b => b.endedAt === null);
  const choose = (choice: Session["reminders"][number]["choice"]) => {
    const pending = s.reminders.find(r => r.choice === "pending");
    if (pending) pending.choice = choice;
  };
  switch (command.type) {
    case "tick":
      if (!Number.isFinite(command.elapsedMs) || command.elapsedMs <= 0 || s.phase === "recovered") return data;
      if (s.phase === "resting") { s.restMs += command.elapsedMs; if (open) open.durationMs += command.elapsedMs; }
      else s.workMs += command.elapsedMs;
      if (s.phase === "working" && s.workMs >= s.nextReminderWorkMs) {
        s.phase = "reminder"; s.reminders.push({ at: command.now, choice: "pending" });
      }
      break;
    case "yes":
      if (s.phase !== "working" && s.phase !== "reminder") return data;
      choose("yes"); s.phase = "resting";
      s.breaks.push({ startedAt: command.now, endedAt: null, durationMs: 0, workCheckpointMs: s.workMs,
        progress: "", problem: "", reason: command.reason });
      break;
    case "no":
      if (s.phase !== "reminder") return data;
      choose("no"); s.phase = "working";
      s.nextReminderWorkMs = s.workMs + (demo ? 8_000 : data.settings.snoozeMinutes * 60_000);
      break;
    case "note":
      if (s.phase !== "resting" || !open) return data;
      // Preserve input while typing (including spaces); no duplicate break is created.
      open.progress = command.progress.slice(0, 2000); open.problem = command.problem.slice(0, 2000); break;
    case "return":
      if (s.phase !== "resting") return data;
      if (open) open.endedAt = command.now;
      s.phase = "working"; s.nextReminderWorkMs = s.workMs + interval(data.settings); break;
    case "resume":
      if (s.phase !== "recovered") return data;
      if (open) open.endedAt = s.updatedAt;
      choose("interrupted"); s.phase = "working";
      s.nextReminderWorkMs = s.workMs + interval(data.settings); break;
    case "end":
      if (open) open.endedAt = s.phase === "recovered" ? s.updatedAt : command.now;
      choose("ended"); s.endedAt = command.now; s.updatedAt = command.now;
      return { ...data, active: null, history: [s, ...data.history] };
  }
  s.updatedAt = command.now;
  return { ...data, active: s };
}
export function restoreData(data: PochiData): PochiData {
  return data.active ? { ...data, active: { ...data.active, phase: "recovered" } } : data;
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
