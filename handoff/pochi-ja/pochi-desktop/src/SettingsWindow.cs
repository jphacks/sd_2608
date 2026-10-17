using System;
using System.IO;
using System.Linq;
using System.Media;
using System.Speech.Synthesis;
using System.Windows;
using System.Windows.Controls;

namespace Pochi
{
    public static class ReminderSound
    {
        private static SoundPlayer player;
        private static SpeechSynthesizer speech;
        public static void Play(string sound)
        {
            try
            {
                if (sound == "silent") return;
                if (sound == "voice")
                {
                    if (speech == null) speech = new SpeechSynthesizer();
                    string culture = "ja-JP";
                    InstalledVoice voice = speech.GetInstalledVoices().FirstOrDefault(v => v.Enabled && v.VoiceInfo.Culture.Name == culture);
                    if (voice != null)
                    {
                        speech.SelectVoice(voice.VoiceInfo.Name); speech.SpeakAsyncCancelAll();
                        speech.SpeakAsync("ひと休みしよう"); return;
                    }
                }
                if (player == null) { player = new SoundPlayer(Assets.Open("chime.wav")); player.Load(); }
                player.Play();
            }
            catch (InvalidOperationException) { SystemSounds.Asterisk.Play(); }
        }
    }

    public sealed class SettingsWindow : Window
    {
        public Settings Result { get; private set; }
        private readonly ComboBox rhythm, rest, snooze, sound, size;
        private readonly CheckBox top;
        public SettingsWindow(Store store, SessionEngine engine)
        {
            Settings config = engine.Config;
            Ui.ConfigureWindow(this, "ポチ · 設定", 510, 650);
            Grid root = new Grid { Margin = new Thickness(24) };
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            StackPanel head = new StackPanel(); head.Children.Add(Ui.Title("いっしょに過ごすリズム"));
            head.Children.Add(Ui.Text("ポチをダブルクリックすると、いつでも設定できます。", 13, Ui.Sub)); root.Children.Add(head);
            StackPanel panel = new StackPanel();
            rhythm = Minutes(new[] { 1, 5, 15, 25, 30, 45, 60, 90, 120 }, config.RemindMinutes);
            rest = Minutes(new[] { 1, 3, 5, 10, 15, 20, 30 }, config.RestMinutes);
            snooze = Minutes(new[] { 1, 5, 10, 15, 30, 60 }, config.SnoozeMinutes);
            sound = Choice(new[] { "やさしいチャイム", "ポチの声（システム音声）", "音なし" }, config.Sound == "voice" ? 1 : config.Sound == "silent" ? 2 : 0);
            size = Minutes(new[] { 150, 180, 210, 240, 270, 300 }, config.PetSize);
            AddField(panel, "休憩を知らせるまでの作業時間（分）", rhythm);
            AddField(panel, "休憩の長さ（分）", rest);
            AddField(panel, "「今は続ける」を選んだ後、再通知まで（分）", snooze);
            AddField(panel, "通知音", sound);
            panel.Children.Add(Ui.Button("試聴する", delegate { ReminderSound.Play(sound.SelectedIndex == 1 ? "voice" : sound.SelectedIndex == 2 ? "silent" : "chime"); }, false));
            AddField(panel, "ポチの大きさ（px）", size);
            top = new CheckBox { Content = "ポチを手前に表示", IsChecked = config.AlwaysOnTop, Margin = new Thickness(0, 12, 0, 14) }; panel.Children.Add(top);
            panel.Children.Add(Ui.Text("作業と休憩の記録は、このPCのアプリ内だけで確認できます。", 13, Ui.Sage));
            panel.Children.Add(Ui.Button("作業と休憩の記録を見る", delegate { ReportWindow r = new ReportWindow(store, engine, false) { Owner = this }; r.ShowDialog(); }, false));
            if (engine.Demo) panel.Children.Add(Ui.Text("デモ：12秒で通知、休憩8秒。通常起動では分単位の設定です。", 12, Ui.Sub));
            ScrollViewer scroll = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }; Grid.SetRow(scroll, 1); root.Children.Add(scroll);
            Button done = Ui.Button("保存してもどる", delegate
            {
                Result = new Settings { RemindMinutes = Selected(rhythm), RestMinutes = Selected(rest), SnoozeMinutes = Selected(snooze),
                    PetSize = Selected(size), Language = "ja", Sound = sound.SelectedIndex == 1 ? "voice" : sound.SelectedIndex == 2 ? "silent" : "chime",
                    AlwaysOnTop = top.IsChecked == true, Left = config.Left, Top = config.Top };
                Result.Validate(); DialogResult = true;
            }, true);
            done.HorizontalAlignment = HorizontalAlignment.Right; Grid.SetRow(done, 2); root.Children.Add(done); Content = root;
        }
        private static void AddField(StackPanel panel, string name, Control input)
        { panel.Children.Add(Ui.Text(name, 13, Ui.Ink)); System.Windows.Automation.AutomationProperties.SetName(input, name); panel.Children.Add(input); }
        private static ComboBox Choice(string[] items, int selected)
        { ComboBox box = new ComboBox { ItemsSource = items, SelectedIndex = selected, MinHeight = 38, Padding = new Thickness(7), Margin = new Thickness(0, 0, 0, 15), FontSize = 14 }; return box; }
        private static ComboBox Minutes(int[] options, int value)
        {
            int[] items = options.Concat(new[] { value }).Distinct().OrderBy(n => n).ToArray();
            ComboBox box = new ComboBox { ItemsSource = items, SelectedItem = value, MinHeight = 38, Padding = new Thickness(7), Margin = new Thickness(0, 0, 0, 15), FontSize = 14 }; return box;
        }
        private static int Selected(ComboBox box) { return (int)box.SelectedItem; }
    }
}
