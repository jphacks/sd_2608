using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Pochi
{
    public static class SelfTests
    {
        private static int checks;
        private static readonly List<string> cases = new List<string>();
        private static void Check(bool value, string message)
        { checks++; if (!value) throw new InvalidOperationException(message); }
        public static int Run(string directory)
        {
            Directory.CreateDirectory(directory);
            try
            {
                DateTime now = new DateTime(2026, 10, 17, 1, 0, 0, DateTimeKind.Utc);
                Settings cfg = new Settings { RemindMinutes = 1, RestMinutes = 1, SnoozeMinutes = 1 };
                Check(new Settings().Language == "ja", "Japanese default on first launch");
                Settings legacyLanguage = new Settings { Language = "zh", RemindMinutes = 45 };
                legacyLanguage.Validate();
                Check(legacyLanguage.Language == "ja" && legacyLanguage.RemindMinutes == 45, "legacy language migrates without changing timing");
                SessionEngine e = new SessionEngine(cfg, false);
                Check(e.Start("测试任务", "work", now), "start"); Check(!e.Start("重复", "work", now), "duplicate start rejected");
                Check(!e.Advance(59999, now), "no early reminder"); Check(e.Advance(1, now), "reminder boundary");
                Check(e.Phase == Phase.Reminder, "reminder waits for choice");
                e.Advance(2000, now); Check(e.Current.WorkMs == 62000, "choice wait counts as working");
                Check(e.DeclineRest(), "NO accepted"); Check(e.Current.Breaks.Count == 0, "NO must not add break");
                Check(e.Current.Reminders[0].Choice == "no", "NO stored");
                Check(!e.Advance(59999, now), "snooze respected"); Check(e.Advance(1, now), "snooze reminds again");
                cases.Add("作業時間・通知待ち・休憩しない場合の再通知");
                Check(e.AcceptRest(now, "reminder"), "YES accepted"); Check(!e.AcceptRest(now, "reminder"), "duplicate YES rejected");
                Check(e.Current.Breaks.Count == 1, "exactly one break");
                double work = e.Current.WorkMs; e.Advance(120000, now);
                Check(e.Current.WorkMs == work && e.Current.RestMs == 120000, "rest excluded from working");
                Check(e.OpenBreak.DurationMs == 120000, "individual break duration");
                Check(e.SaveProgress("完成第 3 页", "需要再核对数据"), "save progress");
                Check(e.Current.Breaks.Count == 1, "saving progress must not add break");
                Check(e.ReturnToWork(now.AddMinutes(4)), "return accepted"); Check(!e.ReturnToWork(now), "duplicate return rejected");
                Check(e.Current.Breaks[0].Progress == "完成第 3 页", "progress retained");
                Check(e.OpenBreak == null, "break closed");
                cases.Add("休憩の重複防止・進捗の保存・休憩時間の分離・作業の再開");
                double due = e.Current.NextReminderWorkMs;
                e.UpdateSettings(new Settings { RemindMinutes = 1, Language = "ja" });
                Check(e.Current.NextReminderWorkMs == due, "language settings must not reset timer");
                e.UpdateSettings(new Settings { RemindMinutes = 2 });
                Check(e.Current.NextReminderWorkMs == e.Current.WorkMs + 120000, "rhythm update");
                Check(e.RequestReminder(now), "manual trigger"); Check(!e.RequestReminder(now), "no duplicate reminder");
                Check(e.AcceptRest(now, "manual"), "manual rest"); e.Advance(30000, now);
                Session final = e.End(now.AddMinutes(5));
                Check(final.Breaks.Count == 2 && final.RestMs == 150000, "exit during rest preserves totals");
                Check(final.Breaks[1].EndedUtc.HasValue, "exit closes open break");
                double finalWork = final.WorkMs; e.Advance(5000, now); Check(final.WorkMs == finalWork, "ended timer stops");
                cases.Add("設定変更時の計時・手動休憩・休憩中の終了とレポート作成");

                string testStore = Path.Combine(directory, "store-" + Guid.NewGuid().ToString("N"));
                Store store = new Store(testStore); store.Finish(final, cfg); store.Finish(final, cfg);
                Store loaded = new Store(testStore);
                Check(loaded.Data.Reports.Count == 1, "report saved once");
                Check(loaded.Data.Reports[0].Breaks[0].Problem == "需要再核对数据", "round-trip notes");
                SessionEngine interrupted = new SessionEngine(cfg, false); interrupted.Start("未完成", "study", now); interrupted.Advance(15000, now);
                store.Save(interrupted); loaded = new Store(testStore);
                SessionEngine restored = new SessionEngine(cfg, false); restored.Restore(loaded.Data.ActiveSession);
                restored.Advance(86400000, now.AddDays(1));
                Check(restored.Phase == Phase.Recovered && restored.Current.WorkMs == 15000, "offline time excluded");
                Check(restored.ResumeRecovered(now.AddDays(1)), "recovery resume"); restored.Advance(5000, now);
                Check(restored.Current.WorkMs == 20000, "recovered timing resumes");
                File.WriteAllText(Path.Combine(testStore, "pochi-data.json"), "{broken", Encoding.UTF8);
                Store backup = new Store(testStore); Check(!String.IsNullOrEmpty(backup.RecoveryNotice), "backup recovery notice");
                Check(backup.Data.Reports.Count == 1, "backup history preserved");
                cases.Add("ローカル保存・終了処理の重複防止・中断とバックアップからの復元");

                Assets assets = new Assets(); Check(assets.Actions.Count == 8, "seven actions plus derived lie transition");
                int pngs = 0;
                foreach (KeyValuePair<string, ActionSpec> pair in assets.Actions)
                {
                    ActionSpec a = pair.Value; Check(a.frames.Length == a.durations_ms.Length, "frame timings " + pair.Key);
                    Check(a.durations_ms.All(d => d > 0 && d % 10 == 0), "valid timing " + pair.Key);
                    foreach (string frame in a.frames)
                        using (Stream stream = Assets.Open(frame)) { Check(stream.ReadByte() == 137, "embedded PNG " + frame); }
                    if (pair.Key != "sit_to_rest") pngs += a.frames.Length;
                }
                Check(pngs == 107, "all 107 active PNGs embedded");
                ActionSpec rise = assets.Actions["rest_to_sit"], lie = assets.Actions["sit_to_rest"];
                Check(lie.frames.SequenceEqual(rise.frames.Reverse()), "sitting-to-lying uses exact reverse frames");
                Check(Hash(rise.frames[0]) == Hash(assets.Actions["rest"].frames[0]), "rise begins at lying pose");
                Check(Hash(rise.frames.Last()) == Hash(assets.Actions["idle"].frames[0]), "rise ends at sitting pose");
                Check(Hash(lie.frames[0]) == Hash(assets.Actions["idle"].frames[0]), "lie begins at sitting pose");
                Check(Hash(lie.frames.Last()) == Hash(assets.Actions["rest"].frames[0]), "lie ends at lying pose");
                Check(Ui.Local(now).Hour == 10, "Japan timezone");
                cases.Add("PNG全107枚・8種類の動作・遷移の始点と終点・日本時間");
                cases.Add("日本語の初期表示・旧言語設定の移行・入力したメモの原文保持");
                WriteResult(directory, true, null); return 0;
            }
            catch (Exception ex) { WriteResult(directory, false, ex.ToString()); return 1; }
        }
        private static string Hash(string frame)
        { using (Stream stream = Assets.Open(frame)) using (SHA256 hash = SHA256.Create()) return Convert.ToBase64String(hash.ComputeHash(stream)); }
        private static void WriteResult(string directory, bool passed, string error)
        {
            var report = new { passed = passed, assertions = checks, cases = cases, error = error };
            File.WriteAllText(Path.Combine(directory, "test-results.json"), new JavaScriptSerializer().Serialize(report), new UTF8Encoding(false));
        }
    }
}
