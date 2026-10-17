use super::history::*;
use super::{Time, WindowKey};
fn target(window: &str, fingerprint: u64) -> Option<MaskedWindow> {
    Some(MaskedWindow {
        key: WindowKey {
            process_id: 123,
            window_id: window.into(),
        },
        title_fingerprint: fingerprint,
        app_name: "editor.exe".into(),
        title: "[URL]".into(),
    })
}
fn history() -> History {
    let mut h = History::default();
    h.begin(
        1,
        Time {
            utc_ms: 100_000,
            elapsed_ms: 0,
        },
    );
    h
}
#[test]
fn combines_only_identical_window_and_original_title_without_storing_original() {
    let mut h = history();
    h.record(0, target("one", 1));
    h.record(1000, target("one", 1));
    h.record(2000, target("two", 1));
    h.record(3000, target("two", 2));
    h.record(4000, target("two", 2));
    let (_, _, segments) = h.freeze(1, 4000).unwrap();
    assert_eq!(
        segments
            .iter()
            .map(|s| (s.start, s.end))
            .collect::<Vec<_>>(),
        vec![(0, 2000), (2000, 3000), (3000, 4000)]
    );
}
#[test]
fn exclusions_duplicate_samples_and_missing_intervals_do_not_extend_history() {
    let mut h = history();
    h.record(0, target("one", 1));
    h.record(1000, None);
    h.record(2000, target("one", 1));
    h.record(2000, target("other", 2));
    h.record(3000, target("one", 1));
    h.record(10_000, target("one", 1));
    h.record(11_000, None);
    let (_, _, segments) = h.freeze(1, 20_000).unwrap();
    assert_eq!(
        segments
            .iter()
            .map(|s| (s.start, s.end))
            .collect::<Vec<_>>(),
        vec![(0, 1000), (2000, 3000), (10_000, 11_000)]
    );
}
#[test]
fn clips_copies_retroactive_away_and_session_isolation() {
    let mut h = history();
    for i in 0..=10 {
        h.record(i * 1000, target("one", 1));
    }
    let frozen = h.freeze(1, 4500).unwrap();
    assert_eq!(frozen.2[0].end, 4500);
    h.end(6500);
    h.record(12_000, target("other", 2));
    assert_eq!(h.freeze(1, 20_000).unwrap().2[0].end, 6500);
    assert_eq!(frozen.2[0].end, 4500);
    h.begin(
        2,
        Time {
            utc_ms: 200_000,
            elapsed_ms: 20_000,
        },
    );
    assert!(h.freeze(1, 25_000).is_none());
    assert!(h.freeze(2, 25_000).unwrap().2.is_empty());
}
#[test]
fn bounded_to_thirty_minutes_six_hundred_segments_and_fresh_tail() {
    let mut h = history();
    for i in 0..=2000 {
        h.record(i * 1000, target("one", 1));
    }
    let (start, end, segments) = h.freeze(1, 2_000_000).unwrap();
    assert_eq!((start, end), (200_000, 2_000_000));
    assert_eq!((segments[0].start, segments[0].end), (start, end));
    let mut h = history();
    for i in 0..=1000 {
        h.record(i * 1000, target("one", i));
    }
    let (_, _, segments) = h.freeze(1, 1_000_000).unwrap();
    assert_eq!(segments.len(), 600);
    assert_eq!(segments[0].start, 400_000);
    let (_, _, segments) = h.freeze(1, 1_100_000).unwrap();
    assert_eq!(segments.last().unwrap().end, 1_005_000);
}
