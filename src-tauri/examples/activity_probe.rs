//! 手動の実機確認用。明示実行時のみ読み取り、タイトル・プロセス名・ID を出力しない。
use sd_2608_lib::{
    infrastructure::NativeActivitySource,
    ports::activity::{ActivitySource, Foreground},
};

fn main() {
    let seconds = std::env::args()
        .nth(1)
        .map(|n| n.parse::<u64>().expect("seconds: 1..60"))
        .unwrap_or(10);
    assert!((1..=60).contains(&seconds), "seconds: 1..60");
    let source = NativeActivitySource;
    let mut previous_window = None;
    for tick in 0..seconds {
        match source.read(&[]) {
            Ok(reading) => {
                let (kind, current_window) = match reading.foreground {
                    Foreground::External(window) => {
                        ("external", Some((window.window_id, window.process_id)))
                    }
                    Foreground::Pet => ("pet", None),
                    Foreground::Excluded => ("excluded", None),
                    Foreground::Restricted => ("restricted", None),
                    Foreground::Unavailable => ("unavailable", None),
                };
                let changed = previous_window.is_some()
                    && current_window.is_some()
                    && previous_window != current_window;
                println!(
                    "second={tick} foreground={kind} idle_ms={:?} window_changed={changed}",
                    reading.idle_ms
                );
                previous_window = current_window;
            }
            Err(_) => println!("second={tick} source=unavailable"),
        }
        if tick + 1 < seconds {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
}
