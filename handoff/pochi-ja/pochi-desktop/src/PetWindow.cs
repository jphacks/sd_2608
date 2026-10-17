using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;

namespace Pochi
{
    public sealed class PetWindow : Window
    {
        private readonly Store store;
        private readonly SessionEngine engine;

        private readonly Animator animator;
        private readonly Border bubble;
        private readonly StackPanel bubbleBody = new StackPanel();
        private readonly StackPanel dock = new StackPanel();
        private readonly Button petButton;
        private readonly TextBlock status;
        private readonly DispatcherTimer clock = new DispatcherTimer();
        private readonly DispatcherTimer singleClick = new DispatcherTimer();
        private readonly Stopwatch stopwatch = Stopwatch.StartNew();
        private readonly Forms.NotifyIcon tray = new Forms.NotifyIcon();
        private readonly Assets assets;
        private long lastTick, lastSave;
        private bool busy, settingsOpen, settingsPending, reminderDisplayed, suspended, allowClose, ending;
        private bool dragging, doubleClicked, isLying, restNotified;
        private Point down;
        private string view = "none", kind = "work";
        private int bubbleVersion;
        private TextBox taskBox, progressBox, problemBox;

        public PetWindow(Store store, bool demo)
        {
            this.store = store; engine = new SessionEngine(store.Data.Settings, demo);
            engine.Restore(store.Data.ActiveSession);

            Title = "ポチ · デスクトップペット"; Width = 430; Height = Math.Min(700, SystemParameters.WorkArea.Height - 12);
            WindowStyle = WindowStyle.None; AllowsTransparency = true; Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize; ShowInTaskbar = true; Topmost = engine.Config.AlwaysOnTop;
            FontFamily = new FontFamily("Yu Gothic UI, Meiryo, Segoe UI"); FontSize = 14; Foreground = Ui.Ink;
            Grid root = new Grid(); Content = root;
            Image dog = new Image { Stretch = Stretch.Uniform, IsHitTestVisible = false };
            petButton = new Button { Content = dog, Background = Brushes.Transparent, BorderThickness = new Thickness(0),
                Padding = new Thickness(0), Cursor = Cursors.Hand, HorizontalAlignment = HorizontalAlignment.Right,
                ToolTip = "クリック：作業 · ダブルクリック：設定 · ドラッグ：移動" };
            FrameworkElementFactory presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            petButton.Template = new ControlTemplate(typeof(Button)) { VisualTree = presenter };
            AutomationProperties.SetName(petButton, "ポチ：クリックで作業を記録、ダブルクリックで設定");
            dock.VerticalAlignment = VerticalAlignment.Bottom; dock.HorizontalAlignment = HorizontalAlignment.Right; dock.Margin = new Thickness(0, 0, 12, 10);
            dock.Children.Add(petButton);
            StackPanel bar = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            status = Ui.Text("", 11, Ui.Sub); status.Margin = new Thickness(8, 0, 8, 0); status.VerticalAlignment = VerticalAlignment.Center;
            Border pill = Ui.CardBorder(status, 14); pill.Padding = new Thickness(4, 5, 4, 5); pill.Margin = new Thickness(0, 0, 4, 0); bar.Children.Add(pill);
            bar.Children.Add(SmallButton("⚙", "設定", OpenSettings));
            bar.Children.Add(SmallButton("▤", "記録を見る", ShowReports));
            bar.Children.Add(SmallButton("−", "通知領域へ", delegate { Hide(); }));
            bar.Children.Add(SmallButton("×", "レポートを作って終了", delegate { EndSession(true); }));
            dock.Children.Add(bar); root.Children.Add(dock);
            bubble = Ui.CardBorder(new ScrollViewer { Content = bubbleBody, VerticalScrollBarVisibility = ScrollBarVisibility.Auto }, 24);
            bubble.VerticalAlignment = VerticalAlignment.Bottom; bubble.Margin = new Thickness(18, 0, 18, 280);
            bubble.Effect = new DropShadowEffect { BlurRadius = 20, ShadowDepth = 4, Opacity = 0.16, Color = System.Windows.Media.Color.FromRgb(74, 44, 30) };
            root.Children.Add(bubble);
            assets = new Assets(); animator = new Animator(assets, dog);
            using (Stream icon = Assets.Open("idle/000.png")) Icon = System.Windows.Media.Imaging.BitmapFrame.Create(icon);
            ApplyAppearance(); Place();
            petButton.PreviewMouseLeftButtonDown += PetDown;
            petButton.PreviewMouseMove += PetMove;
            petButton.PreviewMouseLeftButtonUp += PetUp;
            petButton.KeyDown += delegate(object sender, KeyEventArgs e) { if (e.Key == Key.Enter || e.Key == Key.Space) { e.Handled = true; SingleTap(); } };
            singleClick.Interval = TimeSpan.FromMilliseconds(Forms.SystemInformation.DoubleClickTime + 40);
            singleClick.Tick += delegate { singleClick.Stop(); SingleTap(); };
            ContextMenu context = new ContextMenu();
            AddMenu(context, "作業の記録 / メニュー", SingleTap);
            AddMenu(context, "設定", OpenSettings);
            AddMenu(context, "作業と休憩の記録", ShowReports);
            AddMenu(context, "ひとまわりして座る", TurnAround);
            AddMenu(context, "今回の作業を終える", delegate { EndSession(false); });
            AddMenu(context, "レポートを作って終了", delegate { EndSession(true); });
            petButton.ContextMenu = context;
            SetupTray();
            clock.Interval = TimeSpan.FromMilliseconds(200); clock.Tick += ClockTick; clock.Start();
            SystemEvents.PowerModeChanged += OnPowerMode;
            Closing += OnClosing;
            Application.Current.SessionEnding += OnSessionEnding;
            Loaded += delegate
            {
                animator.Play("idle", true);
                if (engine.Phase == Phase.Recovered) ShowRecovery(); else ShowHome();
                if (!String.IsNullOrEmpty(store.RecoveryNotice)) MessageBox.Show(this, store.RecoveryNotice, "ポチ");
            };
        }

        private Button SmallButton(string label, string accessibleName, Action action)
        {
            Button button = Ui.Button(label, action, false); button.MinHeight = 30; button.Padding = new Thickness(8, 2, 8, 2);
            button.Margin = new Thickness(2, 0, 0, 0); button.FontSize = 15; button.ToolTip = accessibleName;
            AutomationProperties.SetName(button, accessibleName); return button;
        }
        private static void AddMenu(ContextMenu menu, string label, Action action)
        { MenuItem item = new MenuItem { Header = label }; item.Click += delegate { action(); }; menu.Items.Add(item); }
        private void ApplyAppearance()
        {
            Topmost = engine.Config.AlwaysOnTop;
            petButton.Width = engine.Config.PetSize; petButton.Height = engine.Config.PetSize;
            bubble.Margin = new Thickness(18, 0, 18, engine.Config.PetSize + 58);
            bubble.MaxHeight = Math.Max(220, Height - engine.Config.PetSize - 78);
        }
        private void Place()
        {
            Rect area = SystemParameters.WorkArea;
            Left = engine.Config.Left >= area.Left && engine.Config.Left < area.Right - 100 ? engine.Config.Left : area.Right - Width - 12;
            Top = engine.Config.Top >= area.Top && engine.Config.Top < area.Bottom - 100 ? engine.Config.Top : area.Bottom - Height;
            Left = Math.Max(area.Left, Math.Min(Left, area.Right - Width)); Top = Math.Max(area.Top, Math.Min(Top, area.Bottom - Height));
        }
        private void PetDown(object sender, MouseButtonEventArgs e)
        {
            down = e.GetPosition(this); dragging = false; doubleClicked = e.ClickCount >= 2;
            if (doubleClicked) { singleClick.Stop(); OpenSettings(); }
            e.Handled = true;
        }
        private void PetMove(object sender, MouseEventArgs e)
        {
            if (e.LeftButton != MouseButtonState.Pressed || doubleClicked || dragging) return;
            Point point = e.GetPosition(this);
            if (Math.Abs(point.X - down.X) < SystemParameters.MinimumHorizontalDragDistance && Math.Abs(point.Y - down.Y) < SystemParameters.MinimumVerticalDragDistance) return;
            dragging = true; singleClick.Stop();
            try { DragMove(); } catch (InvalidOperationException) { }
            PlaceAfterDrag();
        }
        private void PlaceAfterDrag()
        {
            Rect area = SystemParameters.WorkArea;
            Left = Math.Max(area.Left, Math.Min(Left, area.Right - Width)); Top = Math.Max(area.Top, Math.Min(Top, area.Bottom - Height));
            engine.Config.Left = Left; engine.Config.Top = Top; Persist();
        }
        private void PetUp(object sender, MouseButtonEventArgs e)
        { if (!dragging && !doubleClicked) { singleClick.Stop(); singleClick.Start(); } e.Handled = true; }

        private void SetView(string name, string title, string message)
        {
            view = name; bubbleVersion++; bubbleBody.Children.Clear(); bubble.Visibility = Visibility.Visible;
            if (!String.IsNullOrEmpty(title)) bubbleBody.Children.Add(Ui.Title(title));
            if (!String.IsNullOrEmpty(message)) bubbleBody.Children.Add(Ui.Text(message, 14, Ui.Ink));
        }
        private void HideBubble() { view = "none"; bubbleVersion++; bubble.Visibility = Visibility.Collapsed; }
        private void ShowHome()
        {
            SetView("home", "今日も、いっしょに", "クリックで作業を記録。ダブルクリックで休憩の設定。");
            bubbleBody.Children.Add(Ui.Button("作業を記録", ShowStart, true));
        }
        private void ShowRecovery()
        {
            SetView("recovery", "前回の記録が残っています", "終了中の時間は含めていません。前回の作業を続けますか？");
            bubbleBody.Children.Add(Ui.Button("前回の作業を続ける", delegate { PumpTime(); if (engine.ResumeRecovered(DateTime.UtcNow)) { Persist(); Flow(GoLie); } }, true));
            bubbleBody.Children.Add(Ui.Button("終了してレポートを見る", delegate { EndSession(false); }, false));
        }
        private void SingleTap()
        {
            if (busy || settingsOpen || ending) return;
            if (engine.Phase == Phase.Recovered) { ShowRecovery(); return; }
            if (!engine.Active) { if (view == "start") StartWork(); else ShowStart(); return; }
            if (engine.Phase == Phase.Reminder) { ShowQuestion(); return; }
            if (engine.Phase == Phase.Resting) { ShowRestStatus(); return; }
            if (view == "welcome") { ContinueWorking(); return; }
            ShowWorkMenu();
        }
        private void ShowStart()
        {
            if (busy || engine.Active) return;
            animator.Play("record", false); isLying = false;
            SetView("start", "今日は何から始める？", "作業を書いて、もう一度ポチをクリックするか開始を押してね。");
            ComboBox choice = new ComboBox { ItemsSource = new[] { "作業", "勉強" }, SelectedIndex = kind == "study" ? 1 : 0, MinHeight = 36, Margin = new Thickness(0, 0, 0, 12) };
            choice.SelectionChanged += delegate { kind = choice.SelectedIndex == 1 ? "study" : "work"; }; bubbleBody.Children.Add(choice);
            taskBox = Ui.Input("", "今回の作業", false); bubbleBody.Children.Add(taskBox);
            bubbleBody.Children.Add(Ui.Button("作業の記録をはじめる", StartWork, true));
        }
        private void StartWork()
        {
            if (busy || settingsOpen || engine.Active) return;
            PumpTime();
            if (!engine.Start(taskBox == null ? "" : taskBox.Text, kind, DateTime.UtcNow)) return;
            reminderDisplayed = false; Persist();
            SetView("started", "記録をはじめたよ", "ここで伏せて待ってるね。時間になったら声をかけるよ。");
            int version = bubbleVersion;
            Flow(async delegate { await GoLie(); await Task.Delay(1200); if (bubbleVersion == version) HideBubble(); });
        }
        private void ShowWorkMenu()
        {
            SetView("menu", "ここにいるよ", String.IsNullOrWhiteSpace(engine.Current.Task) ? "どうする？" : engine.Current.Task);
            bubbleBody.Children.Add(Ui.Button("いま休憩する", delegate { AcceptRest("manual"); }, true));
            bubbleBody.Children.Add(Ui.Button("作業と休憩の記録を見る", ShowReports, false));
            bubbleBody.Children.Add(Ui.Button("今回の作業を終える", delegate { EndSession(false); }, false));
            bubbleBody.Children.Add(Ui.Button("作業を続ける", ContinueWorking, false));
        }
        private void ShowQuestion()
        {
            if (engine.Phase != Phase.Reminder) return;
            SetView("reminder", "少し立って、休憩しない？", "しばらく集中していたね。のびをして、目も休めよう。");
            bubbleBody.Children.Add(Ui.Button("はい・休憩する", delegate { AcceptRest("reminder"); }, true));
            bubbleBody.Children.Add(Ui.Button("いいえ・今は続ける", DeclineRest, false));
            bubbleBody.IsEnabled = !busy;
        }
        private void MaybePrompt()
        {
            if (busy || settingsOpen || ending || engine.Phase != Phase.Reminder || reminderDisplayed) return;
            reminderDisplayed = true;
            Flow(async delegate
            {
                await Wake();
                ShowQuestion(); bubbleBody.IsEnabled = false;
                ReminderSound.Play(engine.Config.Sound);
                await animator.Play("reminder", false);
            });
        }
        private void AcceptRest(string reason)
        {
            if (busy || settingsOpen) return;
            PumpTime(); if (!engine.AcceptRest(DateTime.UtcNow, reason)) return;
            reminderDisplayed = false; restNotified = false; Persist(); ShowProgress();
            Flow(async delegate { await Wake(); await animator.Play("record", false); await GoLie(); });
        }
        private void ShowProgress()
        {
            SetView("progress", "しおりに残しておこう", "休憩はもう始まっているよ。どこまで進んだ？戻ったら続きをしよう。");
            bubbleBody.Children.Add(Ui.Text("どこまで進んだ", 13, Ui.Sub));
            progressBox = Ui.Input(engine.OpenBreak == null ? "" : engine.OpenBreak.Progress, "どこまで進んだ", true); bubbleBody.Children.Add(progressBox);
            bubbleBody.Children.Add(Ui.Text("困っていること（空でもOK）", 13, Ui.Sub));
            problemBox = Ui.Input(engine.OpenBreak == null ? "" : engine.OpenBreak.Problem, "困っていること", true); bubbleBody.Children.Add(problemBox);
            bubbleBody.Children.Add(Ui.Button("残して、ひと休み", SaveProgress, true));
            bubbleBody.Children.Add(Ui.Button("いまは書かない", ShowRestStatus, false));
        }
        private void SaveProgress()
        {
            if (busy) return;
            engine.SaveProgress(progressBox == null ? "" : progressBox.Text, problemBox == null ? "" : problemBox.Text); Persist(); ShowRestStatus();
        }
        private void ShowRestStatus()
        {
            if (engine.Phase != Phase.Resting) return;
            SetView("rest", "休憩中。ゆっくりね", "しっぽを振って待ってるね。準備ができたら「戻ったよ」と教えて。");
            bubbleBody.Children.Add(Ui.Button("戻ったよ", ReturnToWork, true));
            bubbleBody.Children.Add(Ui.Button("作業の進みを残す", ShowProgress, false));
        }
        private void DeclineRest()
        {
            if (busy) return;
            PumpTime(); if (!engine.DeclineRest()) return;
            reminderDisplayed = false; Persist();
            SetView("declined", "休憩も忘れないでね", "わかった。もう少しいっしょに。あとでまた声をかけるね。");
            int version = bubbleVersion;
            Flow(async delegate { await Task.Delay(1400); await GoLie(); if (bubbleVersion == version) HideBubble(); });
        }
        private void ReturnToWork()
        {
            if (busy || engine.Phase != Phase.Resting) return;
            PumpTime(); if (!engine.ReturnToWork(DateTime.UtcNow)) return;
            reminderDisplayed = false; Persist();
            Flow(async delegate
            {
                await Wake();
                SetView("welcome", "おかえりなさい", "しおりを取っておいたよ。さっきの続きからはじめよう。");
                bubbleBody.Children.Add(Ui.Button("作業を続ける", ContinueWorking, true));
                bubbleBody.Children.Add(Ui.Button("前回の進みを見る", ShowReports, false));
                bubbleBody.IsEnabled = false; await animator.Play("welcome", false);
            });
        }
        private void ContinueWorking()
        { if (busy || !engine.Active || engine.Phase != Phase.Working) return; HideBubble(); Flow(GoLie); }

        private async Task Wake()
        { if (isLying) { await animator.Play("rest_to_sit", false); isLying = false; } }
        private async Task GoLie()
        {
            if (!isLying) { await animator.Play("sit_to_rest", false); isLying = true; }
            animator.Play("rest", true);
        }
        private async void Flow(Func<Task> action)
        {
            if (busy || ending) return;
            busy = true; bubbleBody.IsEnabled = false;
            try { await action(); }
            finally
            {
                busy = false; bubbleBody.IsEnabled = true;
                if (settingsPending) { settingsPending = false; OpenSettings(); }
                else MaybePrompt();
            }
        }
        private void TurnAround()
        {
            if (busy || settingsOpen || engine.Phase == Phase.Reminder || engine.Phase == Phase.Recovered || engine.Phase == Phase.Resting) return;
            Flow(async delegate { await Wake(); await animator.Play("turn_sit", false); if (engine.Active) await GoLie(); else animator.Play("idle", true); });
        }
        private void OpenSettings()
        {
            singleClick.Stop(); if (settingsOpen || ending) return;
            if (busy) { settingsPending = true; return; }
            settingsOpen = true;
            SettingsWindow settings = new SettingsWindow(store, engine) { Owner = this, Topmost = Topmost };
            if (settings.ShowDialog() == true) { PumpTime(); engine.UpdateSettings(settings.Result); ApplyAppearance(); Persist(); }
            settingsOpen = false;
            if (!engine.Active) ShowHome(); else if (engine.Phase == Phase.Recovered) ShowRecovery();
            MaybePrompt();
        }
        private void ShowReports()
        {
            if (ending) return;
            if (busy) return;
            PumpTime(); Persist(); bool old = settingsOpen; settingsOpen = true;
            ReportWindow report = new ReportWindow(store, engine, false) { Owner = this, Topmost = Topmost }; report.ShowDialog();
            settingsOpen = old; MaybePrompt();
        }

        private void PumpTime()
        {
            long current = stopwatch.ElapsedMilliseconds; long delta = current - lastTick; lastTick = current;
            if (!suspended) engine.Advance(delta, DateTime.UtcNow);
        }
        private void ClockTick(object sender, EventArgs e)
        {
            PumpTime();
            if (engine.Phase == Phase.Resting && engine.OpenBreak != null && !restNotified && engine.OpenBreak.DurationMs >= engine.RestTargetMs)
            {
                restNotified = true; ReminderSound.Play(engine.Config.Sound);
                if (view != "progress" && !settingsOpen && !busy)
                {
                    ShowRestStatus(); bubbleBody.Children.Insert(0, Ui.Text("休憩の時間になったよ。続ける準備はできた？", 14, Ui.Sage));
                }
            }
            if (engine.Active && stopwatch.ElapsedMilliseconds - lastSave > 5000) { Persist(); lastSave = stopwatch.ElapsedMilliseconds; }
            UpdateStatus(); MaybePrompt();
        }
        private void UpdateStatus()
        {
            string label = "待機中";
            if (engine.Phase == Phase.Working || engine.Phase == Phase.Reminder) label = "作業 " + Ui.Duration(engine.Current.WorkMs);
            else if (engine.Phase == Phase.Resting) label = "休憩 " + Ui.Duration(engine.OpenBreak == null ? 0 : engine.OpenBreak.DurationMs);
            else if (engine.Phase == Phase.Recovered) label = "復元待ち";
            status.Text = (engine.Demo ? "デモ · " : "") + label;
        }
        private void Persist()
        {
            try { store.Save(engine); }
            catch (IOException) { status.Text = "保存できません"; }
            catch (UnauthorizedAccessException) { status.Text = "保存先に書き込めません"; }
        }
        private void OnPowerMode(object sender, PowerModeChangedEventArgs e)
        {
            Dispatcher.BeginInvoke(new Action(delegate
            {
                if (e.Mode == PowerModes.Suspend) { PumpTime(); suspended = true; Persist(); }
                else if (e.Mode == PowerModes.Resume) { lastTick = stopwatch.ElapsedMilliseconds; suspended = false; }
            }));
        }
        private void SetupTray()
        {
            using (Stream stream = Assets.Open("pet.ico")) using (System.Drawing.Icon icon = new System.Drawing.Icon(stream)) tray.Icon = (System.Drawing.Icon)icon.Clone();
            tray.Text = "ポチ · デスクトップペット";
            tray.DoubleClick += delegate { Dispatcher.BeginInvoke(new Action(delegate { Show(); Activate(); })); };
            Forms.ContextMenuStrip menu = new Forms.ContextMenuStrip();
            AddTray(menu, "ポチを表示", delegate { Show(); Activate(); });
            AddTray(menu, "設定", delegate { Show(); OpenSettings(); });
            AddTray(menu, "記録を見る", delegate { Show(); ShowReports(); });
            AddTray(menu, "レポートを作って終了", delegate { EndSession(true); });
            tray.ContextMenuStrip = menu; tray.Visible = true;
        }
        private void AddTray(Forms.ContextMenuStrip menu, string label, Action action)
        { Forms.ToolStripMenuItem item = new Forms.ToolStripMenuItem(label); item.Click += delegate { Dispatcher.BeginInvoke(action); }; menu.Items.Add(item); }
        private void EndSession(bool quit)
        {
            if (ending) return;
            if (busy) { MessageBox.Show(this, "動きが終わるまで、少し待ってね。", "ポチ"); return; }
            PumpTime();
            if (view == "progress" && engine.OpenBreak != null) engine.SaveProgress(progressBox.Text, problemBox.Text);
            Session session = engine.End(DateTime.UtcNow);
            try { store.Finish(session, engine.Config); }
            catch (IOException ex) { ShowSaveError(ex); return; }
            catch (UnauthorizedAccessException ex) { ShowSaveError(ex); return; }
            ending = true; animator.Stop(); singleClick.Stop();
            if (session != null)
            {
                Show(); ReportWindow report = new ReportWindow(store, engine, quit) { Owner = this, Topmost = Topmost }; report.ShowDialog();
            }
            ending = false;
            if (quit) Shutdown();
            else { isLying = false; animator.Play("idle", true); ShowHome(); }
        }
        private void ShowSaveError(Exception error)
        {
            Program.LogError(store.DirectoryPath, error);
            MessageBox.Show(this, "記録を保存できなかったため、終了せずに待機します。\n保存先の空き容量とアクセス権をご確認ください。", "ポチ · 保存エラー");
        }
        private void OnClosing(object sender, CancelEventArgs e)
        { if (!allowClose) { e.Cancel = true; Dispatcher.BeginInvoke(new Action(delegate { EndSession(true); })); } }
        private void OnSessionEnding(object sender, SessionEndingCancelEventArgs e)
        {
            PumpTime(); if (engine.Active) engine.End(DateTime.UtcNow);
            try { store.Finish(engine.Current, engine.Config); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            Cleanup(); allowClose = true;
        }
        private void Cleanup()
        { clock.Stop(); singleClick.Stop(); animator.Stop(); tray.Visible = false; tray.Dispose(); SystemEvents.PowerModeChanged -= OnPowerMode; }
        private void Shutdown() { Cleanup(); allowClose = true; Application.Current.Shutdown(); }
    }
}
