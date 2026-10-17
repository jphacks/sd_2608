import { checkedSettings, freshData, restoreData } from "./model.js";
import type { PochiData, Session } from "./model.js";
export interface Repository { load(): { data: PochiData; notice: string }; save(data: PochiData): void; release(): void }
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
const KEY = "pochi.manual.v1", BACKUP = `${KEY}.backup`, LEASE = `${KEY}.lease`;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
function isSession(value: unknown, ended: boolean): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Session;
  return typeof s.id === "string" && typeof s.task === "string" && ["work", "study"].includes(s.kind)
    && finite(s.startedAt) && finite(s.updatedAt) && (ended ? finite(s.endedAt) : s.endedAt === null)
    && ["working", "reminder", "resting", "recovered"].includes(s.phase)
    && finite(s.workMs) && finite(s.restMs) && finite(s.nextReminderWorkMs)
    && Array.isArray(s.breaks) && s.breaks.every(b => !!b && finite(b.startedAt)
      && (b.endedAt === null || finite(b.endedAt)) && finite(b.durationMs) && finite(b.workCheckpointMs)
      && typeof b.progress === "string" && typeof b.problem === "string" && ["manual", "reminder"].includes(b.reason))
    && s.breaks.filter(b => b.endedAt === null).length <= (ended ? 0 : 1)
    && Array.isArray(s.reminders) && s.reminders.every(r => !!r && finite(r.at)
      && ["pending", "yes", "no", "ended", "interrupted"].includes(r.choice));
}
export function decodeData(raw: string): PochiData {
  const data: PochiData = JSON.parse(raw);
  if (!data || data.version !== 1 || !data.settings || !Array.isArray(data.history)
    || !data.history.every(s => isSession(s, true)) || !(data.active === null || isSession(data.active, false)))
    throw new Error("記録データの形式を確認できません。");
  checkedSettings(data.settings); return data;
}
/** Synchronous writes make the final pagehide checkpoint possible without async unload work. */
export class LocalRepository implements Repository {
  private blocked = false;
  constructor(private storage: StoragePort, private owner: string, private now: () => number = Date.now) {}
  load(): { data: PochiData; notice: string } {
    try {
      const raw = this.storage.getItem(KEY);
      if (raw === null) return { data: freshData(), notice: "" };
      try { return { data: restoreData(decodeData(raw)), notice: "" }; }
      catch {
        const backup = this.storage.getItem(BACKUP);
        if (backup !== null) return { data: restoreData(decodeData(backup)), notice: "予備の保存データから復元しました。停止中の時間は加算していません。" };
        throw new Error("invalid data");
      }
    } catch {
      this.blocked = true;
      return { data: freshData(), notice: "保存データを読み込めません。元のデータを保護するため記録を停止しています。保存領域を確認して再読み込みしてください。" };
    }
  }
  save(data: PochiData): void {
    if (this.blocked) throw new Error("保存データの確認が必要です。元のデータは上書きしていません。");
    const lease = this.storage.getItem(LEASE);
    if (lease) {
      let parsed: { owner: string; until: number };
      try { parsed = JSON.parse(lease); } catch { throw new Error("保存領域の使用状況を確認できません。"); }
      if (parsed.owner !== this.owner && parsed.until > this.now()) {
        this.blocked = true;
        throw new Error("別のポチが記録中です。そちらを閉じてから再読み込みしてください。");
      }
    }
    this.storage.setItem(LEASE, JSON.stringify({ owner: this.owner, until: this.now() + 10_000 }));
    const previous = this.storage.getItem(KEY);
    if (previous !== null) {
      // Do not copy a corrupted primary over the valid recovery copy.
      try { decodeData(previous); this.storage.setItem(BACKUP, previous); } catch (error) {
        if (error instanceof DOMException) throw error;
      }
    }
    this.storage.setItem(KEY, JSON.stringify(data));
  }
  release(): void {
    try { const lease = JSON.parse(this.storage.getItem(LEASE) ?? "null"); if (lease?.owner === this.owner) this.storage.removeItem(LEASE); }
    catch { /* Closing never deletes a session or masks the primary save error. */ }
  }
}
