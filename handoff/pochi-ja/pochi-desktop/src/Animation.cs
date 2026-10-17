using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Pochi
{
    public sealed class ActionSpec
    {
        public string label { get; set; }
        public string[] frames { get; set; }
        public int[] durations_ms { get; set; }
        public bool loop { get; set; }
    }
    public sealed class AssetManifest
    {
        public Dictionary<string, ActionSpec> actions { get; set; }
    }
    public sealed class Assets
    {
        public Dictionary<string, ActionSpec> Actions { get; private set; }
        private readonly Dictionary<string, BitmapImage> cache = new Dictionary<string, BitmapImage>();
        public Assets()
        {
            using (Stream stream = Open("manifest.json"))
            using (StreamReader reader = new StreamReader(stream))
                Actions = new JavaScriptSerializer().Deserialize<AssetManifest>(reader.ReadToEnd()).actions;
            ActionSpec rise = Actions["rest_to_sit"];
            // This is an actual sitting-to-lying sequence, not the unrelated full turn.
            Actions.Add("sit_to_rest", new ActionSpec { label = "お座りから伏せへ", loop = false,
                frames = rise.frames.Reverse().ToArray(), durations_ms = rise.durations_ms.Reverse().ToArray() });
        }
        public static Stream Open(string file)
        {
            Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Pochi.assets." + file.Replace('/', '.').Replace('\\', '.'));
            if (stream == null) throw new FileNotFoundException("内蔵アニメーションが見つかりません：" + file);
            return stream;
        }
        public BitmapImage Frame(string file)
        {
            BitmapImage image;
            if (cache.TryGetValue(file, out image)) return image;
            using (Stream stream = Open(file))
            {
                image = new BitmapImage(); image.BeginInit(); image.CacheOption = BitmapCacheOption.OnLoad;
                image.DecodePixelWidth = 300; image.StreamSource = stream; image.EndInit(); image.Freeze();
            }
            cache.Add(file, image); return image;
        }
    }
    public sealed class Animator
    {
        private readonly Assets assets;
        private readonly Image image;
        private readonly DispatcherTimer timer = new DispatcherTimer(DispatcherPriority.Render);
        private ActionSpec action;
        private int index;
        private bool loop;
        private TaskCompletionSource<bool> completion;
        public string CurrentAction { get; private set; }
        public Animator(Assets assets, Image image) { this.assets = assets; this.image = image; timer.Tick += Tick; }
        public Task<bool> Play(string name, bool repeat)
        {
            Stop(); CurrentAction = name; action = assets.Actions[name]; index = 0; loop = repeat;
            completion = new TaskCompletionSource<bool>();
            ShowFrame(); timer.Start(); return completion.Task;
        }
        public void Stop()
        {
            timer.Stop(); TaskCompletionSource<bool> old = completion; completion = null;
            if (old != null) old.TrySetResult(false);
        }
        private void ShowFrame()
        {
            image.Source = assets.Frame(action.frames[index]);
            timer.Interval = TimeSpan.FromMilliseconds(Math.Max(10, action.durations_ms[index]));
        }
        private void Tick(object sender, EventArgs e)
        {
            timer.Stop(); index++;
            if (index >= action.frames.Length)
            {
                if (!loop)
                {
                    TaskCompletionSource<bool> done = completion; completion = null;
                    if (done != null) done.TrySetResult(true);
                    return;
                }
                index = 0;
            }
            ShowFrame(); timer.Start();
        }
    }
}
