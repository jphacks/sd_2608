using System;
using System.IO;
using System.Globalization;
using System.Threading;
using System.Windows;

namespace Pochi
{
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            Thread.CurrentThread.CurrentCulture = CultureInfo.GetCultureInfo("ja-JP");
            Thread.CurrentThread.CurrentUICulture = CultureInfo.GetCultureInfo("ja-JP");
            FrameworkElement.LanguageProperty.OverrideMetadata(typeof(FrameworkElement),
                new FrameworkPropertyMetadata(System.Windows.Markup.XmlLanguage.GetLanguage("ja-JP")));
            string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
            string defaultData = File.Exists(Path.Combine(baseDirectory, "portable.flag")) ? Path.Combine(baseDirectory, "data") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PochiDesktop");
            string data = GetArg(args, "--data-dir") ?? defaultData;
            if (Array.IndexOf(args, "--self-test") >= 0) return SelfTests.Run(data);
            using (Mutex mutex = new Mutex(false, "Local\\PochiDesktop-" + StableId(Path.GetFullPath(data))))
            {
                bool owns = false;
                try { owns = mutex.WaitOne(0, false); } catch (AbandonedMutexException) { owns = true; }
                if (!owns) { MessageBox.Show("ポチはすでに起動しています。タスクバーの通知領域から開いてください。", "ポチ"); return 0; }
                try
                {
                    Application app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
                    app.DispatcherUnhandledException += delegate(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
                    {
                        LogError(data, e.Exception);
                        MessageBox.Show("エラーが発生しました。自動保存された記録は次回起動時に復元できます。\n詳細は保存先の error.log をご確認ください。", "ポチ");
                        e.Handled = true; app.Shutdown(1);
                    };
                    Store store = new Store(data);
                    PetWindow window = new PetWindow(store, Array.IndexOf(args, "--demo") >= 0);
                    app.MainWindow = window; window.Show(); app.Run(); return 0;
                }
                catch (Exception ex)
                {
                    LogError(data, ex);
                    MessageBox.Show("ポチを起動できませんでした。\n保存先へのアクセスと .NET Framework をご確認ください。\n詳細は保存先の error.log をご確認ください。", "ポチ · 起動エラー"); return 1;
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        public static void LogError(string directory, Exception error)
        {
            try
            {
                Directory.CreateDirectory(directory);
                File.AppendAllText(Path.Combine(directory, "error.log"), DateTime.UtcNow.ToString("o") + " " + error + Environment.NewLine);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        private static string GetArg(string[] args, string name)
        { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        private static string StableId(string text)
        { uint hash = 2166136261; foreach (char c in text.ToLowerInvariant()) hash = unchecked((hash ^ c) * 16777619); return hash.ToString("x8"); }
    }
}
