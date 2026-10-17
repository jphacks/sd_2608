using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Pochi
{
    public sealed class ReportWindow : Window
    {
        private readonly StackPanel details = new StackPanel();
        private readonly ListBox list = new ListBox();

        public ReportWindow(Store store, SessionEngine engine, bool exiting)
        {

            Ui.ConfigureWindow(this, "ポチ · 作業と休憩の記録", 760, 680);
            Grid root = new Grid { Margin = new Thickness(22) };
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            StackPanel header = new StackPanel();
            header.Children.Add(Ui.Title((exiting ? "おつかれさま。休憩レポートができました" : "作業と休憩の記録")));
            header.Children.Add(Ui.Text("記録はこのPCだけに保存され、次回も確認できます。", 12, Ui.Sub));
            root.Children.Add(header);
            Grid body = new Grid(); body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) }); body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            list.Background = Ui.Card; list.BorderBrush = Ui.Line; list.Margin = new Thickness(0, 0, 16, 0);
            body.Children.Add(list);
            ScrollViewer scroll = new ScrollViewer { Content = details, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            Grid.SetColumn(scroll, 1); body.Children.Add(scroll); Grid.SetRow(body, 1); root.Children.Add(body);
            Button close = Ui.Button((exiting ? "閉じて終了" : "ポチにもどる"), delegate { Close(); }, true);
            close.HorizontalAlignment = HorizontalAlignment.Right; Grid.SetRow(close, 2); root.Children.Add(close); Content = root;
            Session[] sessions = store.Data.Reports.AsEnumerable().Reverse().ToArray();
            if (engine.Active) sessions = new[] { engine.Current }.Concat(sessions).ToArray();
            foreach (Session session in sessions)
            {
                ListBoxItem item = new ListBoxItem { Padding = new Thickness(8), Tag = session };
                StackPanel label = new StackPanel();
                label.Children.Add(Ui.Text(Ui.Local(session.StartedUtc).ToString("MM/dd HH:mm"), 14, Ui.Ink));
                label.Children.Add(Ui.Text(String.IsNullOrWhiteSpace(session.Task) ? "作業名なし" : session.Task, 12, Ui.Sub));
                label.Children.Add(Ui.Text(session.EndedUtc.HasValue ? "完了" : "作業中", 11, Ui.Sage));
                item.Content = label; list.Items.Add(item);
            }
            list.SelectionChanged += delegate { ListBoxItem item = list.SelectedItem as ListBoxItem; if (item != null) ShowSession((Session)item.Tag); };
            if (list.Items.Count > 0) list.SelectedIndex = 0;
            else details.Children.Add(Ui.Text("記録はまだありません。最初の作業を始めましょう。", 15, Ui.Sub));
        }
        private void ShowSession(Session session)
        {
            details.Children.Clear();
            details.Children.Add(Ui.Title(String.IsNullOrWhiteSpace(session.Task) ? "今回の記録" : session.Task));
            string end = session.EndedUtc.HasValue ? Ui.Time(session.EndedUtc.Value) : "作業中";
            details.Children.Add(Ui.Text(Ui.Local(session.StartedUtc).ToString("yyyy/MM/dd HH:mm") + " — " + end + "（日本時間）", 12, Ui.Sub));
            Grid stats = new Grid { Margin = new Thickness(0, 8, 0, 16) };
            string[] names = { "作業時間", "休憩時間", "休憩回数" };
            string[] values = { Ui.Duration(session.WorkMs), Ui.Duration(session.RestMs), session.Breaks.Count.ToString() };
            for (int i = 0; i < 3; i++)
            {
                stats.ColumnDefinitions.Add(new ColumnDefinition()); StackPanel box = new StackPanel();
                box.Children.Add(Ui.Text(names[i], 12, Ui.Sub)); TextBlock value = Ui.Text(values[i], 18, Ui.Sage); value.FontWeight = FontWeights.SemiBold; box.Children.Add(value);
                Border card = Ui.CardBorder(box, 12); card.Padding = new Thickness(10); card.Margin = new Thickness(0, 0, 6, 0); Grid.SetColumn(card, i); stats.Children.Add(card);
            }
            details.Children.Add(stats);
            details.Children.Add(Ui.Text("声かけ " + session.Reminders.Count + " 回 · 続ける " + session.Reminders.Count(r => r.Choice == "no") + " 回", 12, Ui.Sub));
            details.Children.Add(Ui.Title("休憩と進み具合"));
            int index = 0;
            foreach (BreakEntry entry in session.Breaks)
            {
                StackPanel block = new StackPanel();
                block.Children.Add(Ui.Text("#" + (++index) + "   " + Ui.Time(entry.StartedUtc) + " — " + (entry.EndedUtc.HasValue ? Ui.Time(entry.EndedUtc.Value) : "休憩中"), 14, Ui.Ink));
                block.Children.Add(Ui.Text("休憩 " + Ui.Duration(entry.DurationMs) + " · ここまでの作業 " + Ui.Duration(entry.WorkCheckpointMs), 12, Ui.Sub));
                block.Children.Add(Ui.Text("進捗：" + (String.IsNullOrWhiteSpace(entry.Progress) ? "—" : entry.Progress), 14, Ui.Ink));
                if (!String.IsNullOrWhiteSpace(entry.Problem)) block.Children.Add(Ui.Text("困りごと：" + entry.Problem, 13, Ui.Sub));
                Border card = Ui.CardBorder(block, 14); card.Margin = new Thickness(0, 0, 0, 12); card.Padding = new Thickness(14); details.Children.Add(card);
            }
            if (index == 0) details.Children.Add(Ui.Text("この作業の休憩記録はまだありません。", 14, Ui.Sub));
            if (session.RecoveredAfterInterruption) details.Children.Add(Ui.Text("中断から復元された記録です。終了中の時間は含みません。", 12, Ui.Sub));
        }
    }
}
