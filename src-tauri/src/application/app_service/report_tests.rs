use super::*;
use super::{
    sitting_tests::Rig,
    tests::{error_code, snapshot},
};
use crate::{
    infrastructure::storage::{MemoryRepository, MemorySecretStore},
    ports::storage::*,
};
use std::{
    sync::{atomic::AtomicBool, mpsc},
    time::Duration,
};
fn card(service: &AppService, id: &Id) -> Report {
    match service
        .dispatch("main", Command::ReportGet, Some(json!({"reportId":id})))
        .result
    {
        ApiResult::Success(value) => serde_json::from_value(value).unwrap(),
        _ => panic!("missing card"),
    }
}
fn accept(rig: &Rig, id: &str) -> Id {
    match rig.answer(rig.answer_request(id, "yes")).result {
        ApiResult::Success(value) => serde_json::from_value(value["reportId"].clone()).unwrap(),
        _ => panic!("yes failed"),
    }
}
fn prompt(rig: &mut Rig) {
    rig.stable();
    rig.run(35, true, 0);
}
fn wait_ready(service: &AppService, id: &Id, attempt: u64) {
    for _ in 0..200 {
        if snapshot(service).jobs.iter().any(|job| {
            job.id == *id && job.status == JobStatus::Ready && job.attempt.get() == attempt
        }) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("completion timeout");
}
#[test]
fn yes_is_immediate_exactly_once_and_later_yes_reuses_completed_card() {
    let mut rig = Rig::new();
    prompt(&mut rig);
    let request = rig.answer_request("yes", "yes");
    let first = rig.answer(request.clone());
    assert_eq!(rig.answer(request).result, first.result);
    let id = snapshot(&rig.service)
        .session
        .unwrap()
        .report_job_id
        .unwrap();
    assert!(rig.service.report_worker.step());
    let ready = card(&rig.service, &id);
    assert_eq!(ready.status, ReportStatus::Local);
    assert!(!ready.history.segments.is_empty());
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 1);
    assert!(!rig.service.report_worker.step());
    rig.run(10, true, 0);
    assert_eq!(accept(&rig, "later-yes"), id);
    assert_eq!(snapshot(&rig.service).jobs.len(), 1);
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 1);
    rig.run(6, false, 60_000);
    assert_eq!(snapshot(&rig.service).presence.value, Presence::Away);
    assert_eq!(snapshot(&rig.service).jobs.len(), 1);
    assert_eq!(card(&rig.service, &id), ready);
}
#[test]
fn away_waits_from_confirmation_survives_return_and_freezes_the_old_session() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(10, true, 0);
    rig.step(1000, false, 60_000);
    let missing = rig.clock.read().utc_ms;
    rig.run(5, false, 60_000);
    let view = snapshot(&rig.service);
    let job = view.jobs[0].clone();
    assert_eq!(job.status, JobStatus::Scheduled);
    assert_eq!(job.due_at.get(), rig.clock.read().utc_ms + 5000);
    assert_eq!(job.requested_at.get(), rig.clock.read().utc_ms);
    assert!(!rig.service.report_worker.step());
    rig.run(4, true, 0);
    assert!(!rig.service.report_worker.step());
    rig.step(1000, true, 0);
    let current = snapshot(&rig.service).session.unwrap();
    assert_ne!(current.id, job.session_id);
    assert!(rig.service.report_worker.step());
    let report = card(&rig.service, &job.id);
    assert_eq!(report.session_id, job.session_id);
    assert_eq!(report.history.range_end.get(), missing);
    assert!(
        report.history.segments.iter().all(
            |segment| segment.session_id == job.session_id && segment.ended_at.get() <= missing
        )
    );
}
#[test]
fn completion_is_published_while_still_away_and_empty_history_creates_local_card() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(6, false, 60_000);
    let id = snapshot(&rig.service).jobs[0].id.clone();
    rig.run(5, false, 60_000);
    let (send, receive) = mpsc::channel();
    rig.service.set_snapshot_publisher(
        &snapshot(&rig.service).runtime.tracking_id.unwrap(),
        Arc::new(move |snapshot| {
            send.send(snapshot.clone()).unwrap();
        }),
    );
    assert!(rig.service.report_worker.step());
    let completed = receive
        .try_iter()
        .find(|snapshot| snapshot.completion_seq.get() == 1)
        .unwrap();
    assert_eq!(completed.presence.value, Presence::Away);
    assert_eq!(card(&rig.service, &id).status, ReportStatus::Local);
    let mut rig = Rig::new();
    prompt(&mut rig);
    {
        let mut state = rig.service.state.lock().unwrap();
        let session = state.domain.as_ref().unwrap().session.clone().unwrap();
        state.history.begin(session.id, session.started_at);
    }
    let id = accept(&rig, "empty");
    assert!(rig.service.report_worker.step());
    let report = card(&rig.service, &id);
    assert!(report.history.segments.is_empty());
    assert_eq!(report.status, ReportStatus::Local);
}
struct Repo {
    inner: MemoryRepository,
    fail: AtomicBool,
    fail_after_save: AtomicBool,
    block: AtomicBool,
    started: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl Repository for Repo {
    fn load_settings(&self) -> StorageResult<Option<SavedSettings>> {
        self.inner.load_settings()
    }
    fn load_reports(&self) -> StorageResult<Option<SavedReports>> {
        self.inner.load_reports()
    }
    fn save_settings(&self, value: &SavedSettings) -> StorageResult<()> {
        self.inner.save_settings(value)
    }
    fn save_reports(&self, value: &SavedReports) -> StorageResult<()> {
        if self.block.swap(false, Ordering::SeqCst) {
            self.started.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        if self.fail.load(Ordering::SeqCst) {
            Err(StorageError::Unavailable)
        } else {
            let result = self.inner.save_reports(value);
            if self.fail_after_save.load(Ordering::SeqCst) {
                self.fail.store(true, Ordering::SeqCst);
            }
            result
        }
    }
}
fn repository(
    rig: &Rig,
    fail: bool,
    block: bool,
) -> (Arc<Repo>, mpsc::Receiver<()>, mpsc::Sender<()>) {
    let (started, receive) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let repo = Arc::new(Repo {
        inner: MemoryRepository::default(),
        fail: AtomicBool::new(fail),
        fail_after_save: AtomicBool::new(false),
        block: AtomicBool::new(block),
        started,
        release: Mutex::new(wait),
    });
    *rig.service.persistence.lock().unwrap() = Persistence::open(
        repo.clone(),
        Arc::new(MemorySecretStore::default()),
        rig.clock.read().utc_ms,
    );
    (repo, receive, release)
}
#[test]
fn storage_failure_is_a_readable_failed_card_and_explicit_retry_preserves_id_and_history() {
    let mut rig = Rig::new();
    let (repo, _, _) = repository(&rig, true, false);
    prompt(&mut rig);
    let id = accept(&rig, "fail");
    assert!(rig.service.report_worker.step());
    let failed = card(&rig.service, &id);
    assert_eq!(failed.status, ReportStatus::Failed);
    assert_eq!(
        failed.error.as_ref().unwrap().code,
        ErrorCode::StorageFailure
    );
    assert!(repo.load_reports().unwrap().is_none());
    assert_eq!(snapshot(&rig.service).jobs[0].status, JobStatus::Failed);
    repo.fail.store(false, Ordering::SeqCst);
    let request = json!({"requestId":"retry","reportId":id,"expectedAttempt":1});
    let first = rig
        .service
        .dispatch("main", Command::ReportRetry, Some(request.clone()));
    assert!(matches!(first.result, ApiResult::Success(_)));
    assert_eq!(
        rig.service
            .dispatch("main", Command::ReportRetry, Some(request))
            .result,
        first.result
    );
    wait_ready(&rig.service, &id, 2);
    let ready = card(&rig.service, &id);
    assert_eq!(ready.history, failed.history);
    assert_eq!(ready.created_at, failed.created_at);
    assert_eq!(ready.attempt.get(), 2);
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 2);
    assert_eq!(
        error_code(rig.service.dispatch(
            "main",
            Command::ReportRetry,
            Some(json!({"requestId":"retry-ready","reportId":id,"expectedAttempt":2}))
        )),
        ErrorCode::InvalidState
    );
}
#[test]
fn stop_during_blocked_save_is_prompt_and_discards_the_old_completion_and_card() {
    let mut rig = Rig::new();
    let (repo, started, release) = repository(&rig, false, true);
    prompt(&mut rig);
    let id = accept(&rig, "blocked");
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| rig.service.report_worker.step());
        let began = started.recv_timeout(Duration::from_secs(2));
        let result = rig.service.stop_for_lifecycle();
        let stopped = snapshot(&rig.service);
        release.send(()).unwrap();
        assert!(began.is_ok());
        assert!(result.unwrap().is_some());
        assert_eq!(stopped.runtime.phase, RuntimePhase::Stopped);
        assert_eq!(stopped.jobs[0].status, JobStatus::Cancelled);
        worker.join().unwrap();
    });
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 0);
    assert!(repo.load_reports().unwrap().unwrap().reports.is_empty());
    assert_eq!(
        error_code(
            rig.service
                .dispatch("main", Command::ReportGet, Some(json!({"reportId":id})))
        ),
        ErrorCode::NotFound
    );
}
#[test]
fn clear_during_blocked_save_advances_generation_before_waiting_and_never_resurrects_data() {
    let mut rig = Rig::new();
    let (repo, started, release) = repository(&rig, false, true);
    prompt(&mut rig);
    accept(&rig, "blocked-clear");
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| rig.service.report_worker.step());
        let began = started.recv_timeout(Duration::from_secs(2));
        let clear = scope.spawn(|| {
            rig.service.dispatch(
                "main",
                Command::DataClear,
                Some(json!({"requestId":"clear"})),
            )
        });
        for _ in 0..200 {
            if snapshot(&rig.service).runtime.phase == RuntimePhase::Stopped {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let stopped = snapshot(&rig.service);
        release.send(()).unwrap();
        assert!(began.is_ok());
        assert_eq!(stopped.runtime.phase, RuntimePhase::Stopped);
        assert!(stopped.jobs.is_empty());
        assert_eq!(stopped.completion_seq.get(), 0);
        worker.join().unwrap();
        assert!(matches!(
            clear.join().unwrap().result,
            ApiResult::Success(_)
        ));
    });
    assert!(repo.load_reports().unwrap().unwrap().reports.is_empty());
    assert!(snapshot(&rig.service).jobs.is_empty());
}
#[test]
fn independent_pending_sessions_complete_in_priority_order_without_mixing_histories() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(6, false, 60_000);
    let first = snapshot(&rig.service).jobs[0].id.clone();
    rig.stable();
    rig.run(6, false, 60_000);
    let second = snapshot(&rig.service).jobs[1].id.clone();
    rig.stable();
    rig.run(35, true, 0);
    let immediate = accept(&rig, "priority-yes");
    for (index, id) in [&immediate, &first, &second].into_iter().enumerate() {
        assert!(rig.service.report_worker.step());
        let view = snapshot(&rig.service);
        assert_eq!(
            view.jobs
                .iter()
                .find(|job| job.id == *id)
                .unwrap()
                .completion_seq
                .unwrap()
                .get(),
            index as u64 + 1
        );
        let report = card(&rig.service, id);
        assert!(
            report
                .history
                .segments
                .iter()
                .all(|segment| segment.session_id == report.session_id)
        );
    }
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 3);
    assert!(!rig.service.report_worker.step());
    rig.service.dispatch(
        "main",
        Command::DataClear,
        Some(json!({"requestId":"clear-completed"})),
    );
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 3);
    assert!(snapshot(&rig.service).jobs.is_empty());
}
#[test]
fn saved_failed_report_can_retry_in_a_new_runtime_with_current_consent() {
    let rig = Rig::new();
    let repo = Arc::new(MemoryRepository::default());
    let mut failed = crate::application::persistence::tests::report(999, rig.clock.read().utc_ms);
    failed.status = ReportStatus::Failed;
    failed.error = Some(ApiError::new(
        ErrorCode::NetworkFailure,
        "架空の通信失敗です。",
    ));
    repo.save_reports(&SavedReports {
        schema_version: 1,
        reports: vec![failed.clone()],
    })
    .unwrap();
    *rig.service.persistence.lock().unwrap() = Persistence::open(
        repo,
        Arc::new(MemorySecretStore::default()),
        rig.clock.read().utc_ms,
    );
    assert!(snapshot(&rig.service).jobs.is_empty());
    let accepted = rig.service.dispatch(
        "main",
        Command::ReportRetry,
        Some(json!({"requestId":"restored-retry","reportId":failed.id,"expectedAttempt":1})),
    );
    assert!(matches!(accepted.result, ApiResult::Success(_)));
    wait_ready(&rig.service, &failed.id, 2);
    let ready = card(&rig.service, &failed.id);
    assert_eq!(ready.history, failed.history);
    assert_eq!(ready.id, failed.id);
    assert_eq!(ready.status, ReportStatus::Local);
}
#[test]
fn simultaneous_yes_retries_accept_one_job_and_one_immutable_history() {
    let mut rig = Rig::new();
    prompt(&mut rig);
    let request = rig.answer_request("double-yes", "yes");
    std::thread::scope(|scope| {
        let first = scope.spawn(|| rig.answer(request.clone()));
        let second = scope.spawn(|| rig.answer(request.clone()));
        assert_eq!(first.join().unwrap().result, second.join().unwrap().result);
    });
    let view = snapshot(&rig.service);
    assert_eq!(view.jobs.len(), 1);
    assert_eq!(rig.service.state.lock().unwrap().reports.inputs.len(), 1);
    assert!(rig.service.report_worker.step());
    assert_eq!(snapshot(&rig.service).completion_seq.get(), 1);
}
#[test]
fn failed_rollback_warns_the_current_runtime_without_reviving_the_cancelled_job() {
    let mut rig = Rig::new();
    let (repo, started, release) = repository(&rig, false, true);
    repo.fail_after_save.store(true, Ordering::SeqCst);
    prompt(&mut rig);
    accept(&rig, "rollback-fail");
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| rig.service.report_worker.step());
        let began = started.recv_timeout(Duration::from_secs(2));
        let stopped = rig.service.stop_for_lifecycle();
        release.send(()).unwrap();
        assert!(began.is_ok());
        assert!(stopped.unwrap().is_some());
        worker.join().unwrap();
    });
    let view = snapshot(&rig.service);
    assert_eq!(view.runtime.phase, RuntimePhase::Stopped);
    assert_eq!(view.jobs[0].status, JobStatus::Cancelled);
    assert_eq!(view.completion_seq.get(), 0);
    assert_eq!(view.warning.unwrap().code, ErrorCode::StorageFailure);
}
