/** Manual workflow. Independent of the sensor/AI IPC contracts. All durations are milliseconds. */
export type Phase = "working" | "reminder" | "resting" | "away" | "recovered";
export type Settings = { remindMinutes: number; restMinutes: number; snoozeMinutes: number;
  petSize: number; alwaysOnTop: boolean; reducedMotion: boolean; sound: "bark" | "chime" | "voice" | "silent";
  cameraDemo: boolean; awayCountsAsRest: boolean; postureDemo: boolean; saveHistory: boolean };
export type BreakRecord = { startedAt: number; endedAt: number | null; durationMs: number;
  workCheckpointMs: number; progress: string; problem: string; reason: "manual" | "reminder" };
export type Session = { id: string; task: string; kind: "work" | "study"; startedAt: number;
  updatedAt: number; endedAt: number | null; phase: Phase; workMs: number; restMs: number;
  nextReminderWorkMs: number; breaks: BreakRecord[]; persisted: boolean;
  absences: { startedAt: number; endedAt: number | null; elapsedMs: number; restMs: number }[];
  reminders: { at: number; choice: "pending" | "yes" | "no" | "ended" | "interrupted" }[] };
export type LocalCard = { id: string; session: Session; trigger: "break" | "away"; dueAt: number;
  status: "scheduled" | "generating" | "ready"; readyAt: number | null };
export type PochiData = { version: 1; settings: Settings; active: Session | null; history: Session[]; cards: LocalCard[] };
export const defaults: Settings = { remindMinutes: 30, restMinutes: 10, snoozeMinutes: 10,
  petSize: 170, alwaysOnTop: true, reducedMotion: false, sound: "chime", cameraDemo: false,
  awayCountsAsRest: false, postureDemo: false, saveHistory: true };
export const freshData = (): PochiData => ({ version: 1, settings: { ...defaults }, active: null, history: [], cards: [] });
export function checkedSettings(input: Settings): Settings {
  const integer = (n: number, min: number, max: number) => Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max;
  if (!integer(input.remindMinutes, 1, 180) || !integer(input.restMinutes, 1, 60)
    || !integer(input.snoozeMinutes, 1, 120) || !integer(input.petSize, 150, 300)
    || typeof input.alwaysOnTop !== "boolean" || typeof input.reducedMotion !== "boolean"
    || ![input.cameraDemo,input.awayCountsAsRest,input.postureDemo,input.saveHistory].every(v => typeof v === "boolean")
    || !["bark", "chime", "voice", "silent"].includes(input.sound)) throw new Error("設定の入力範囲を確認してください。");
  return { ...input };
}
export type Command =
  | { type: "start"; id: string; task: string; kind: "work" | "study"; now: number }
  | { type: "tick"; elapsedMs: number; now: number }
  | { type: "yes"; now: number; reason: "manual" | "reminder" }
  | { type: "no"; now: number }
  | { type: "note"; progress: string; problem: string; now: number }
  | { type: "return" | "resume" | "end" | "leave"; now: number }
  | { type: "settings"; settings: Settings; now: number };
const clean = (s: string, max: number) => s.trim().slice(0, max);
function cardNotes(snapshot: Session, current: Session): Session {
  const copy = JSON.parse(JSON.stringify(snapshot)) as Session;
  copy.persisted = current.persisted;
  copy.breaks = copy.breaks.map(b => {
    const latest = current.breaks.find(item => item.startedAt === b.startedAt);
    return latest ? { ...b, progress: latest.progress, problem: latest.problem } : b;
  });
  return copy;
}
export function reducePochi(data: PochiData, command: Command, demo = false): PochiData {
  const interval = (settings: Settings) => demo ? 12_000 : settings.remindMinutes * 60_000;
  if (command.type === "settings") {
    const settings = checkedSettings(command.settings);
    const active = data.active && { ...data.active };
    if (active?.phase === "working" && settings.remindMinutes !== data.settings.remindMinutes)
      active.nextReminderWorkMs = active.workMs + interval(settings);
    if (active) active.persisted = settings.saveHistory;
    return { ...data, settings, active };
  }
  if (command.type === "start") {
    if (data.active) return data;
    const session: Session = { id: command.id, task: clean(command.task, 120), kind: command.kind,
      startedAt: command.now, updatedAt: command.now, endedAt: null, phase: "working",
      workMs: 0, restMs: 0, nextReminderWorkMs: interval(data.settings), breaks: [], reminders: [], absences: [], persisted: data.settings.saveHistory };
    return { ...data, active: session };
  }
  if (!data.active) return data;
  const s: Session = { ...data.active, breaks: data.active.breaks.map(b => ({ ...b })),
    reminders: data.active.reminders.map(r => ({ ...r })), absences: data.active.absences.map(a => ({ ...a })) };
  const open = s.breaks.find(b => b.endedAt === null);
  const absence = s.absences.find(a => a.endedAt === null);
  let cards = data.cards;
  const choose = (choice: Session["reminders"][number]["choice"]) => {
    const pending = s.reminders.find(r => r.choice === "pending");
    if (pending) pending.choice = choice;
  };
  switch (command.type) {
    case "tick":
      if (!Number.isFinite(command.elapsedMs) || command.elapsedMs <= 0 || s.phase === "recovered") return data;
      if (s.phase === "away") { if (absence) { absence.elapsedMs += command.elapsedMs;
        if (data.settings.awayCountsAsRest) { absence.restMs += command.elapsedMs; s.restMs += command.elapsedMs; } } }
      else if (s.phase === "resting") { s.restMs += command.elapsedMs; if (open) open.durationMs += command.elapsedMs; }
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
      cards = [...cards, { id: `${s.id}:break:${s.breaks.length}`, session: s, trigger: "break",
        dueAt: command.now, status: "generating", readyAt: command.now + 4200 }];
      break;
    case "leave":
      if (s.phase !== "working") return data;
      s.phase = "away"; s.absences.push({ startedAt: command.now, endedAt: null, elapsedMs: 0, restMs: 0 });
      cards = [...cards, { id: `${s.id}:away:${s.absences.length}`, session: s, trigger: "away",
        dueAt: command.now + (demo ? 5000 : 300_000), status: "scheduled", readyAt: null }];
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
      if (s.phase !== "resting" && s.phase !== "away") return data;
      if (open) open.endedAt = command.now;
      if (absence) absence.endedAt = command.now;
      s.phase = "working"; s.nextReminderWorkMs = s.workMs + interval(data.settings); break;
    case "resume":
      if (s.phase !== "recovered") return data;
      if (open) open.endedAt = s.updatedAt;
      if (absence) absence.endedAt = s.updatedAt;
      choose("interrupted"); s.phase = "working";
      s.nextReminderWorkMs = s.workMs + interval(data.settings); break;
    case "end":
      if (open) open.endedAt = s.phase === "recovered" ? s.updatedAt : command.now;
      if (absence) absence.endedAt = s.phase === "recovered" ? s.updatedAt : command.now;
      choose("ended"); s.endedAt = command.now; s.updatedAt = command.now;
      return { ...data, active: null, history: [s, ...data.history], cards: cards.map(c => c.session.id === s.id ? { ...c, session: cardNotes(c.session, s), status: "ready", readyAt: command.now } : c) };
  }
  s.updatedAt = command.now;
  return { ...data, active: s, cards };
}
/** Local report snapshots, no remote AI. Leaving and returning never cancels a scheduled card. */
export function settleCards(data: PochiData, now: number, readyClock = now): PochiData {
  let changed = false;
  const cards = data.cards.map(card => {
    if (card.status === "scheduled" && now >= card.dueAt) {
      changed = true; return { ...card, status: "generating" as const, readyAt: readyClock + 4200 };
    }
    if (card.status === "generating" && card.readyAt !== null && readyClock >= card.readyAt) {
      changed = true;
      const session = data.active?.id === card.session.id ? data.active : data.history.find(s => s.id === card.session.id) ?? card.session;
      return { ...card, status: "ready" as const, session: cardNotes(card.session, session) };
    }
    return card;
  });
  return changed ? { ...data, cards } : data;
}
export function dataForStorage(data: PochiData): PochiData {
  const allowed = (s: Session) => s.persisted && (s.id !== data.active?.id || data.settings.saveHistory);
  return { ...data, active: data.active && allowed(data.active) ? data.active : null,
    history: data.history.filter(allowed), cards: data.cards.filter(c => allowed(c.session)) };
}
export function restoreData(data: PochiData): PochiData {
  return data.active ? { ...data, active: { ...data.active, phase: "recovered" } } : data;
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
