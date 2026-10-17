using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;

namespace Pochi
{
    public static class Ui
    {
        public static readonly Brush Cream = Color("#FFF6E8"), Card = Color("#FFFDF8"), Ink = Color("#4A2C1E"),
            Sub = Color("#7A5A48"), Line = Color("#EBD3B6"), Brown = Color("#8B5E4B"), Sage = Color("#2F6B52"), SageBg = Color("#DDEFE3");
        public static Brush Color(string value) { Brush b = (Brush)new BrushConverter().ConvertFromString(value); b.Freeze(); return b; }
        public static TextBlock Text(string text, double size, Brush brush)
        { return new TextBlock { Text = text, FontSize = size, Foreground = brush, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) }; }
        public static TextBlock Title(string text) { TextBlock t = Text(text, 19, Ink); t.FontWeight = FontWeights.SemiBold; return t; }
        public static Button Button(string text, Action action, bool primary)
        {
            Button b = new Button { Content = text, MinHeight = 40, Padding = new Thickness(15, 8, 15, 8),
                Background = primary ? Brown : Cream, Foreground = primary ? Brushes.White : Ink,
                BorderBrush = primary ? Brown : Line, BorderThickness = new Thickness(1),
                FontSize = 14, Cursor = System.Windows.Input.Cursors.Hand, Margin = new Thickness(0, 4, 8, 4) };
            FrameworkElementFactory border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(13));
            border.SetValue(Border.BackgroundProperty, new System.Windows.TemplateBindingExtension(Control.BackgroundProperty));
            border.SetValue(Border.BorderBrushProperty, new System.Windows.TemplateBindingExtension(Control.BorderBrushProperty));
            border.SetValue(Border.BorderThicknessProperty, new System.Windows.TemplateBindingExtension(Control.BorderThicknessProperty));
            border.SetValue(Border.PaddingProperty, new System.Windows.TemplateBindingExtension(Control.PaddingProperty));
            FrameworkElementFactory presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(presenter); b.Template = new ControlTemplate(typeof(Button)) { VisualTree = border };
            b.Click += delegate { action(); }; AutomationProperties.SetName(b, text); return b;
        }
        public static WrapPanel Buttons(params Button[] buttons)
        { WrapPanel p = new WrapPanel(); foreach (Button b in buttons) p.Children.Add(b); return p; }
        public static Border CardBorder(UIElement content, double radius)
        { return new Border { Background = Card, BorderBrush = Line, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(radius), Padding = new Thickness(20), Child = content }; }
        public static TextBox Input(string value, string accessibleName, bool multiline)
        {
            TextBox box = new TextBox { Text = value ?? "", FontSize = 14, Background = Cream, Foreground = Ink,
                BorderBrush = Line, BorderThickness = new Thickness(1), Padding = new Thickness(10),
                Margin = new Thickness(0, 0, 0, 12), MinHeight = multiline ? 70 : 40,
                AcceptsReturn = multiline, TextWrapping = TextWrapping.Wrap, MaxLength = multiline ? 2000 : 120,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
            AutomationProperties.SetName(box, accessibleName); return box;
        }
        public static DateTime Local(DateTime utc)
        {
            try { return TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), TimeZoneInfo.FindSystemTimeZoneById("Tokyo Standard Time")); }
            catch (TimeZoneNotFoundException) { return DateTime.SpecifyKind(utc, DateTimeKind.Utc).AddHours(9); }
        }
        public static string Time(DateTime utc) { return Local(utc).ToString("HH:mm"); }
        public static string Duration(double ms)
        {
            int total = Math.Max(0, (int)(ms / 1000));
            return String.Format("{0:00}:{1:00}:{2:00}", total / 3600, total / 60 % 60, total % 60);
        }
        public static void ConfigureWindow(Window window, string title, double width, double height)
        {
            window.Title = title; window.Width = width; window.Height = height;
            window.MinWidth = width; window.MinHeight = Math.Min(height, 400);
            window.MaxHeight = SystemParameters.WorkArea.Height - 30;
            window.Background = Cream; window.Foreground = Ink; window.FontFamily = new FontFamily("Yu Gothic UI, Meiryo, Segoe UI");
            window.FontSize = 14; window.WindowStartupLocation = WindowStartupLocation.CenterScreen;
            window.ShowInTaskbar = true;
        }
    }

}
