use super::*;
use crate::ports::clock::ClockReading;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc::{self, Receiver, Sender},
};

struct TestClock(AtomicU64);
impl Clock for TestClock {
    fn read(&self) -> ClockReading {
        ClockReading {
            utc_ms: 1_000 + self.0.load(Ordering::Relaxed),
            elapsed_ms: self.0.load(Ordering::Relaxed),
        }
    }
}
struct ControlledSource {
    requests: Sender<Vec<String>>,
    results: Mutex<Receiver<Result<ActivityReading, ActivityError>>>,
}
impl ActivitySource for ControlledSource {
    fn read(&self, excluded_apps: &[String]) -> Result<ActivityReading, ActivityError> {
        self.requests.send(excluded_apps.to_vec()).unwrap();
        self.results
            .lock()
            .unwrap()
            .recv()
            .unwrap_or(Err(ActivityError::Unavailable))
    }
}
fn reading() -> ActivityReading {
    ActivityReading {
        idle_ms: Some(10),
        foreground: Foreground::Unavailable,
    }
}

#[test]
fn one_worker_survives_duplicate_start_stop_and_restart_during_a_blocked_read() {
    let (request_tx, requests) = mpsc::channel();
    let (results, result_rx) = mpsc::channel();
    let (events, event_rx) = mpsc::channel();
    let source = Arc::new(ControlledSource {
        requests: request_tx,
        results: Mutex::new(result_rx),
    });
    let monitor = ActivityMonitor::new(
        source,
        Arc::new(TestClock(AtomicU64::new(0))),
        Arc::new(move |g, sample| {
            events.send((g, sample)).unwrap();
        }),
    );
    monitor.start(1, vec!["private.exe".into()]).unwrap();
    assert_eq!(
        requests.recv_timeout(Duration::from_secs(2)).unwrap(),
        vec!["private.exe"]
    );
    monitor.start(1, vec![]).unwrap();
    monitor.stop();
    monitor.start(2, vec!["other.exe".into()]).unwrap();
    // 前世代の read がブロック中でも Stop/Start は完了し、二本目の read は始まらない。
    assert!(requests.recv_timeout(Duration::from_millis(50)).is_err());
    results.send(Ok(reading())).unwrap();
    assert_eq!(
        requests.recv_timeout(Duration::from_secs(2)).unwrap(),
        vec!["other.exe"]
    );
    assert!(event_rx.try_recv().is_err());
    results.send(Ok(reading())).unwrap();
    assert_eq!(event_rx.recv_timeout(Duration::from_secs(2)).unwrap().0, 2);
    monitor.stop();
}

#[test]
fn long_reads_are_stale_and_current_source_errors_are_reported_then_recovered() {
    let (request_tx, requests) = mpsc::channel();
    let (results, result_rx) = mpsc::channel();
    let (events, event_rx) = mpsc::channel();
    let clock = Arc::new(TestClock(AtomicU64::new(0)));
    let monitor = ActivityMonitor::new(
        Arc::new(ControlledSource {
            requests: request_tx,
            results: Mutex::new(result_rx),
        }),
        clock.clone(),
        Arc::new(move |_, sample| {
            events.send(sample).unwrap();
        }),
    );
    monitor.start(1, vec![]).unwrap();
    requests.recv_timeout(Duration::from_secs(2)).unwrap();
    clock.0.store(MAX_SAMPLE_AGE_MS + 1, Ordering::Relaxed);
    results.send(Ok(reading())).unwrap();
    assert_eq!(
        event_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(ActivityError::Stale)
    );
    requests.recv_timeout(Duration::from_secs(2)).unwrap();
    results.send(Err(ActivityError::Unavailable)).unwrap();
    assert_eq!(
        event_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(ActivityError::Unavailable)
    );
    requests.recv_timeout(Duration::from_secs(2)).unwrap();
    results.send(Ok(reading())).unwrap();
    assert!(
        event_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .is_ok()
    );
    monitor.stop();
}

#[test]
fn drop_during_blocked_read_discards_the_result_and_does_not_wait_for_os() {
    let (request_tx, requests) = mpsc::channel();
    let (results, result_rx) = mpsc::channel();
    let (events, event_rx) = mpsc::channel();
    let monitor = ActivityMonitor::new(
        Arc::new(ControlledSource {
            requests: request_tx,
            results: Mutex::new(result_rx),
        }),
        Arc::new(TestClock(AtomicU64::new(0))),
        Arc::new(move |_, sample| {
            let _ = events.send(sample);
        }),
    );
    monitor.start(1, vec![]).unwrap();
    requests.recv_timeout(Duration::from_secs(2)).unwrap();
    drop(monitor);
    results.send(Ok(reading())).unwrap();
    // ワーカーが結果を捨てて終了すると Sender も解放される。
    assert!(matches!(
        event_rx.recv_timeout(Duration::from_secs(2)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}
