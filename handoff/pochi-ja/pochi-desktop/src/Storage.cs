using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Pochi
{
    public sealed class SavedData
    {
        public int SchemaVersion { get; set; }
        public Settings Settings { get; set; }
        public Session ActiveSession { get; set; }
        public List<Session> Reports { get; set; }
        public SavedData() { SchemaVersion = 1; Settings = new Settings(); Reports = new List<Session>(); }
    }

    public sealed class Store
    {
        public string DirectoryPath { get; private set; }
        public string RecoveryNotice { get; private set; }
        public SavedData Data { get; private set; }
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
        public Store(string directory)
        {
            DirectoryPath = directory; Directory.CreateDirectory(directory);
            string file = Path.Combine(directory, "pochi-data.json");
            Data = Read(file);
            if (Data == null)
            {
                Data = Read(file + ".bak");
                if (Data != null) RecoveryNotice = "このPCのバックアップから記録を復元しました。";
            }
            if (Data == null)
            {
                Data = new SavedData();
                if (File.Exists(file))
                {
                    // Preserve the original for recovery instead of replacing it silently.
                    File.Copy(file, Path.Combine(directory, "unreadable-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + ".json"));
                    RecoveryNotice = "記録を読み込めませんでした。元のファイルは復元のために保存してあります。";
                }
            }
            if (Data.Settings == null) Data.Settings = new Settings();
            if (Data.Reports == null) Data.Reports = new List<Session>();
            Data.Settings.Validate();
        }

        private SavedData Read(string file)
        {
            try { return File.Exists(file) ? json.Deserialize<SavedData>(File.ReadAllText(file, Encoding.UTF8)) : null; }
            catch (IOException) { return null; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
        }

        public void Save(SessionEngine engine)
        {
            Data.Settings = engine.Config;
            Data.ActiveSession = engine.Active ? engine.Current : null;
            Write();
        }

        public void Finish(Session session, Settings settings)
        {
            if (session != null && session.EndedUtc.HasValue && !Data.Reports.Exists(s => s.Id == session.Id))
                Data.Reports.Add(session);
            Data.Settings = settings; Data.ActiveSession = null; Write();
        }

        private void Write()
        {
            string file = Path.Combine(DirectoryPath, "pochi-data.json");
            string temp = file + ".tmp";
            File.WriteAllText(temp, json.Serialize(Data), new UTF8Encoding(false));
            if (File.Exists(file)) File.Replace(temp, file, file + ".bak");
            else File.Move(temp, file);
        }
    }
}
