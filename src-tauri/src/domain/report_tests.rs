use super::{ReportTrigger, Time, report::*};
fn at(ms: u64) -> Time {
    Time {
        utc_ms: 1_000_000 + ms,
        elapsed_ms: ms,
    }
}
fn add(queue: &mut Queue, id: &str, trigger: ReportTrigger, ms: u64, delay: u64) {
    queue.register(
        id.into(),
        format!("session-{id}"),
        trigger,
        at(ms),
        delay,
        1,
    );
}
#[test]
fn duplicate_session_keeps_id_deadline_and_trigger() {
    let mut q = Queue::default();
    add(&mut q, "one", ReportTrigger::Away, 0, 300_000);
    let job = q.register(
        "other".into(),
        "session-one".into(),
        ReportTrigger::Yes,
        at(1000),
        0,
        2,
    );
    assert_eq!(job.id, "one");
    assert_eq!(job.due_at.elapsed_ms, 300_000);
    assert_eq!(job.trigger, ReportTrigger::Away);
    assert_eq!(q.jobs.len(), 1);
}
#[test]
fn immediate_jobs_precede_due_reservations_but_running_job_is_not_interrupted() {
    let mut q = Queue::default();
    add(&mut q, "away-later", ReportTrigger::Away, 0, 20);
    add(&mut q, "away-earlier", ReportTrigger::Away, 1, 10);
    add(&mut q, "yes", ReportTrigger::Yes, 30, 0);
    assert_eq!(q.take(at(30)).unwrap().id, "yes");
    assert!(q.take(at(30)).is_none());
    assert!(q.finish("yes", 1, 1, false));
    assert_eq!(q.take(at(30)).unwrap().id, "away-earlier");
    assert!(q.finish("away-earlier", 1, 1, false));
    assert_eq!(q.take(at(30)).unwrap().id, "away-later");
}
#[test]
fn reservations_use_monotonic_deadlines_and_expire_once() {
    let mut q = Queue::default();
    add(&mut q, "away", ReportTrigger::Away, 0, 300_000);
    assert!(
        q.take(Time {
            utc_ms: 9_000_000,
            elapsed_ms: 299_999
        })
        .is_none()
    );
    assert_eq!(
        q.take(Time {
            utc_ms: 1,
            elapsed_ms: 300_000
        })
        .unwrap()
        .id,
        "away"
    );
    assert!(q.finish("away", 1, 1, false));
    assert!(q.take(at(900_000)).is_none());
    assert_eq!(q.completion_seq, 1);
}
#[test]
fn only_latest_failed_attempt_can_retry_and_old_completions_are_discarded() {
    let mut q = Queue::default();
    add(&mut q, "yes", ReportTrigger::Yes, 0, 0);
    q.take(at(0));
    assert!(q.finish("yes", 1, 1, true));
    assert!(q.retry("yes", 1, at(1), 2));
    assert!(!q.retry("yes", 1, at(1), 2));
    q.take(at(2));
    assert!(!q.finish("yes", 1, 1, false));
    assert!(q.finish("yes", 2, 2, false));
    assert_eq!(q.completion_seq, 2);
    assert!(!q.retry("yes", 2, at(3), 2));
    add(&mut q, "away", ReportTrigger::Away, 3, 10);
    q.cancel();
    assert!(q.take(at(100)).is_none());
    assert!(!q.retry("away", 1, at(100), 3));
}
