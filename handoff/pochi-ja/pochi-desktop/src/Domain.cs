using System;
using System.Collections.Generic;
using System.Linq;

namespace Pochi
{
    public enum Phase { Idle, Working, Reminder, Resting, Recovered, Ended }

    public sealed class Settings
    {
        public int RemindMinutes { get; set; }
        public int RestMinutes { get; set; }
        public int SnoozeMinutes { get; set; }
        public string Language { get; set; }
        public string Sound { get; set; }
        public bool AlwaysOnTop { get; set; }
        public int PetSize { get; set; }
        public double Left { get; set; }
        public double Top { get; set; }
        public Settings()
        {
            RemindMinutes = 30; RestMinutes = 10; SnoozeMinutes = 10;
            Language = "ja"; Sound = "chime"; AlwaysOnTop = true;
            PetSize = 210; Left = -1; Top = -1;
        }
        public void Validate()
        {
            RemindMinutes = Math.Max(1, Math.Min(180, RemindMinutes));
            RestMinutes = Math.Max(1, Math.Min(60, RestMinutes));
            SnoozeMinutes = Math.Max(1, Math.Min(120, SnoozeMinutes));
            PetSize = Math.Max(150, Math.Min(300, PetSize));
            // Keep the persisted property for compatibility with earlier records.
            Language = "ja";
            if (Sound != "chime" && Sound != "voice" && Sound != "silent") Sound = "chime";
        }
    }

    public sealed class BreakEntry
    {
        public DateTime StartedUtc { get; set; }
        public DateTime? EndedUtc { get; set; }
        public double DurationMs { get; set; }
        public double WorkCheckpointMs { get; set; }
        public string Progress { get; set; }
        public string Problem { get; set; }
        public string Reason { get; set; }
        public BreakEntry() { Progress = ""; Problem = ""; Reason = "reminder"; }
    }

    public sealed class ReminderEntry
    {
        public DateTime AtUtc { get; set; }
        public string Choice { get; set; }
        public ReminderEntry() { Choice = "pending"; }
    }

    public sealed class Session
    {
        public string Id { get; set; }
        public string Task { get; set; }
        public string Kind { get; set; }
        public DateTime StartedUtc { get; set; }
        public DateTime? EndedUtc { get; set; }
        public double WorkMs { get; set; }
        public double RestMs { get; set; }
        public double NextReminderWorkMs { get; set; }
        public Phase SavedPhase { get; set; }
        public List<BreakEntry> Breaks { get; set; }
        public List<ReminderEntry> Reminders { get; set; }
        public bool RecoveredAfterInterruption { get; set; }
        public Session()
        {
            Id = Guid.NewGuid().ToString("N"); Task = ""; Kind = "work";
            Breaks = new List<BreakEntry>(); Reminders = new List<ReminderEntry>();
        }
    }

    // Domain logic deliberately has no dependency on WPF or animation playback.
    public sealed class SessionEngine
    {
        public Settings Config { get; private set; }
        public Session Current { get; private set; }
        public Phase Phase { get; private set; }
        public bool Demo { get; private set; }
        public bool Active { get { return Current != null && !Current.EndedUtc.HasValue; } }
        public double IntervalMs { get { return Demo ? 12000 : Config.RemindMinutes * 60000.0; } }
        public double RestTargetMs { get { return Demo ? 8000 : Config.RestMinutes * 60000.0; } }
        public double SnoozeMs { get { return Demo ? 8000 : Config.SnoozeMinutes * 60000.0; } }
        public BreakEntry OpenBreak { get { return Current == null ? null : Current.Breaks.LastOrDefault(b => !b.EndedUtc.HasValue); } }

        public SessionEngine(Settings config, bool demo)
        { Config = config; Config.Validate(); Demo = demo; Phase = Phase.Idle; }

        public bool Start(string task, string kind, DateTime now)
        {
            if (Active) return false;
            Current = new Session { Task = Clean(task, 120), Kind = kind == "study" ? "study" : "work", StartedUtc = now,
                NextReminderWorkMs = IntervalMs, SavedPhase = Phase.Working };
            Phase = Phase.Working; return true;
        }

        public bool Advance(double elapsedMs, DateTime now)
        {
            if (!Active || elapsedMs <= 0 || Double.IsNaN(elapsedMs) || Double.IsInfinity(elapsedMs)) return false;
            if (Phase == Phase.Working || Phase == Phase.Reminder) Current.WorkMs += elapsedMs;
            else if (Phase == Phase.Resting)
            {
                Current.RestMs += elapsedMs;
                if (OpenBreak != null) OpenBreak.DurationMs += elapsedMs;
            }
            if (Phase == Phase.Working && Current.WorkMs >= Current.NextReminderWorkMs)
            {
                Phase = Phase.Reminder; Current.SavedPhase = Phase;
                Current.Reminders.Add(new ReminderEntry { AtUtc = now });
                return true;
            }
            return false;
        }

        public bool RequestReminder(DateTime now)
        {
            if (!Active || Phase != Phase.Working) return false;
            Phase = Phase.Reminder; Current.SavedPhase = Phase;
            Current.Reminders.Add(new ReminderEntry { AtUtc = now }); return true;
        }

        public bool AcceptRest(DateTime now, string reason)
        {
            if (!Active || (Phase != Phase.Reminder && Phase != Phase.Working)) return false;
            SetChoice("yes");
            Current.Breaks.Add(new BreakEntry { StartedUtc = now, WorkCheckpointMs = Current.WorkMs, Reason = reason });
            Phase = Phase.Resting; Current.SavedPhase = Phase; return true;
        }

        public bool DeclineRest()
        {
            if (!Active || Phase != Phase.Reminder) return false;
            SetChoice("no"); Phase = Phase.Working; Current.SavedPhase = Phase;
            Current.NextReminderWorkMs = Current.WorkMs + SnoozeMs; return true;
        }

        public bool SaveProgress(string progress, string problem)
        {
            if (OpenBreak == null) return false;
            OpenBreak.Progress = Clean(progress, 2000); OpenBreak.Problem = Clean(problem, 2000); return true;
        }

        public bool ReturnToWork(DateTime now)
        {
            if (!Active || Phase != Phase.Resting) return false;
            if (OpenBreak != null) OpenBreak.EndedUtc = now;
            Phase = Phase.Working; Current.SavedPhase = Phase;
            Current.NextReminderWorkMs = Current.WorkMs + IntervalMs; return true;
        }

        public void UpdateSettings(Settings settings)
        {
            settings.Validate(); bool rhythmChanged = settings.RemindMinutes != Config.RemindMinutes; Config = settings;
            if (rhythmChanged && Active && Phase == Phase.Working) Current.NextReminderWorkMs = Current.WorkMs + IntervalMs;
        }

        public void Restore(Session session)
        {
            if (session == null || session.EndedUtc.HasValue) return;
            Current = session; Current.RecoveredAfterInterruption = true;
            Phase = Phase.Recovered;
        }

        public bool ResumeRecovered(DateTime now)
        {
            if (Phase != Phase.Recovered || !Active) return false;
            if (OpenBreak != null) OpenBreak.EndedUtc = now;
            SetChoice("interrupted"); Phase = Phase.Working; Current.SavedPhase = Phase;
            Current.NextReminderWorkMs = Current.WorkMs + IntervalMs; return true;
        }

        public Session End(DateTime now)
        {
            if (!Active) return Current;
            if (OpenBreak != null) OpenBreak.EndedUtc = now;
            SetChoice("ended"); Current.EndedUtc = now; Current.SavedPhase = Phase.Ended;
            Phase = Phase.Ended; return Current;
        }

        private void SetChoice(string choice)
        {
            if (Current == null) return;
            ReminderEntry pending = Current.Reminders.LastOrDefault(r => r.Choice == "pending");
            if (pending != null) pending.Choice = choice;
        }
        private static string Clean(string value, int limit)
        { value = (value ?? "").Trim(); return value.Length > limit ? value.Substring(0, limit) : value; }
    }
}
