use super::*;
use crate::ports::clock::ClockReading;

struct FakeClock(AtomicU64);
impl Clock for FakeClock {
    fn read(&self) -> ClockReading {
        ClockReading {
            utc_ms: self.0.load(Ordering::Relaxed),
            elapsed_ms: 0,
        }
    }
}
fn fixture() -> AppSnapshot {
    serde_json::from_str(include_str!("../../../../tests/fixtures/ipc/snapshot.json")).unwrap()
}
fn service() -> (AppService, Arc<FakeClock>) {
    let expected = fixture();
    let clock = Arc::new(FakeClock(AtomicU64::new(expected.emitted_at.get())));
    (
        AppService::with_clock(clock.clone(), expected.runtime_id).unwrap(),
        clock,
    )
}
fn snapshot(service: &AppService) -> AppSnapshot {
    match service
        .dispatch("main", Command::AppGetSnapshot, None)
        .result
    {
        ApiResult::Success(value) => serde_json::from_value(value).unwrap(),
        result => panic!("{result:?}"),
    }
}
fn error_code(outcome: DispatchOutcome) -> ErrorCode {
    match outcome.result {
        ApiResult::Failure(error) => error.code,
        _ => panic!("expected error"),
    }
}
fn activate(service: &AppService) {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../tests/fixtures/ipc/cases.json")).unwrap();
    let active = cases
        .iter()
        .find(|case| case["name"] == "populated snapshot")
        .unwrap()["value"]["data"]
        .clone();
    service.state.lock().unwrap().snapshot = serde_json::from_value(active).unwrap();
}

#[test]
fn initial_snapshot_matches_shared_fixture_and_reads_do_not_increment_revision() {
    let (service, _) = service();
    assert_eq!(snapshot(&service), fixture());
    assert_eq!(snapshot(&service), fixture());
}
#[test]
fn list_is_empty_get_is_not_found_and_invalid_limits_are_rejected() {
    let (service, _) = service();
    assert_eq!(
        service
            .dispatch(
                "main",
                Command::ReportList,
                Some(json!({"cursor":null,"limit":20}))
            )
            .result,
        ApiResult::Success(json!({"items":[],"nextCursor":null}))
    );
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::ReportGet,
            Some(json!({"reportId":"missing"}))
        )),
        ErrorCode::NotFound
    );
    for request in [
        json!({"cursor":null,"limit":0}),
        json!({"cursor":null,"limit":21}),
        json!({"limit":1}),
        json!({"cursor":"old-cursor","limit":1}),
        json!({"cursor":null,"limit":MAX_SAFE_INTEGER+1}),
    ] {
        assert_eq!(
            error_code(service.dispatch("main", Command::ReportList, Some(request))),
            ErrorCode::Validation
        );
    }
}
#[test]
fn only_main_window_can_access_any_command_even_with_bad_requests() {
    let (service, _) = service();
    for command in [
        Command::AppGetSnapshot,
        Command::RuntimeStart,
        Command::RuntimeStop,
        Command::FaceSubmit,
        Command::ReminderRespond,
        Command::SettingsUpdate,
        Command::ReportList,
        Command::ReportGet,
        Command::ReportRetry,
        Command::DataClear,
    ] {
        assert_eq!(
            error_code(service.dispatch("other", command, None)),
            ErrorCode::PermissionDenied
        );
    }
    assert_eq!(snapshot(&service), fixture());
}
#[test]
fn unavailable_features_validate_requests_and_never_fake_success() {
    let (service, _) = service();
    let start = json!({"requestId":"start","profile":"normal","expectedSettingsRevision":0,"reportMode":"local",
        "consent":{"activity":true,"history":true,"externalReport":false}});
    assert_eq!(
        error_code(service.dispatch("main", Command::RuntimeStart, Some(start.clone()))),
        ErrorCode::InvalidState
    );
    let mut stale = start.clone();
    stale["requestId"] = json!("stale-start");
    stale["expectedSettingsRevision"] = json!(1);
    assert_eq!(
        error_code(service.dispatch("main", Command::RuntimeStart, Some(stale))),
        ErrorCode::StaleRevision
    );
    let mut denied = start;
    denied["requestId"] = json!("denied-start");
    denied["consent"]["history"] = json!(false);
    assert_eq!(
        error_code(service.dispatch("main", Command::RuntimeStart, Some(denied))),
        ErrorCode::ConsentRequired
    );
    assert_eq!(error_code(service.dispatch("main",Command::SettingsUpdate,Some(json!({"requestId":"settings","expectedSettingsRevision":0,
        "values":{"reportMode":"local","provider":null,"excludedApps":[],"reducedMotion":false},"keyChange":{"kind":"replace","value":"do-not-retain"}})))),ErrorCode::InvalidState);
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::ReportRetry,
            Some(json!({"requestId":"retry","reportId":"missing","expectedAttempt":1}))
        )),
        ErrorCode::InvalidState
    );
    assert_eq!(error_code(service.dispatch("main",Command::FaceSubmit,Some(json!({"trackingId":"missing","sequence":1,"observedAt":0,"source":"camera","kind":"sample","faceDetected":true})))),ErrorCode::StaleTracking);
    assert_eq!(error_code(service.dispatch("main",Command::ReminderRespond,Some(json!({"requestId":"answer","trackingId":"missing","sessionId":"missing","reminderId":"missing","answer":"yes"})))),ErrorCode::StaleReminder);
    assert_eq!(snapshot(&service), fixture());
    assert_eq!(service.state.lock().unwrap().receipts.len(), 6);
    assert_eq!(error_code(service.dispatch("main",Command::SettingsUpdate,Some(json!({"requestId":"settings","expectedSettingsRevision":0,
        "values":{"reportMode":"local","provider":null,"excludedApps":[],"reducedMotion":false},"keyChange":{"kind":"replace","value":"different-secret"}})))),ErrorCode::Validation);
}
#[test]
fn clear_is_idempotent_and_request_id_reuse_with_a_different_command_is_rejected() {
    let (service, _) = service();
    let first = service.dispatch(
        "main",
        Command::DataClear,
        Some(json!({"requestId":"clear"})),
    );
    let repeated = service.dispatch(
        "main",
        Command::DataClear,
        Some(json!({"requestId":"clear"})),
    );
    assert_eq!(first.result, repeated.result);
    assert!(first.changed.is_some());
    assert!(repeated.changed.is_none());
    assert_eq!(service.state.lock().unwrap().generation, 1);
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::RuntimeStop,
            Some(json!({"requestId":"clear","trackingId":"old"}))
        )),
        ErrorCode::Validation
    );
    assert_eq!(snapshot(&service).revision.get(), 1);
}
#[test]
fn stopping_invalidates_the_tracking_and_cancels_unfinished_jobs() {
    let (service, _) = service();
    activate(&service);
    let stopped = service.dispatch(
        "main",
        Command::RuntimeStop,
        Some(json!({"requestId":"stop","trackingId":"tracking-1"})),
    );
    assert!(matches!(stopped.result, ApiResult::Success(_)));
    let view = snapshot(&service);
    assert_eq!(view.runtime.phase, RuntimePhase::Stopped);
    assert!(view.runtime.tracking_id.is_none());
    assert_eq!(view.jobs[0].status, JobStatus::Cancelled);
    assert!(view.session.is_none());
    assert!(view.reminder.is_none());
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::RuntimeStop,
            Some(json!({"requestId":"stop-new","trackingId":"tracking-1"}))
        )),
        ErrorCode::StaleTracking
    );
}
#[test]
fn lifecycle_stop_is_safe_to_repeat() {
    let (service, _) = service();
    activate(&service);
    assert!(service.stop_for_lifecycle().unwrap().is_some());
    assert!(service.stop_for_lifecycle().unwrap().is_none());
    assert_eq!(snapshot(&service).runtime.phase, RuntimePhase::Stopped);
}
#[test]
fn clock_failure_does_not_partially_apply_a_mutation() {
    let (service, clock) = service();
    let before = snapshot(&service);
    clock.0.store(MAX_SAFE_INTEGER + 1, Ordering::Relaxed);
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::DataClear,
            Some(json!({"requestId":"bad-clock"}))
        )),
        ErrorCode::Internal
    );
    assert_eq!(snapshot(&service), before);
    assert_eq!(service.state.lock().unwrap().generation, 0);
}
#[test]
fn concurrent_repeated_mutations_apply_once_and_cache_is_bounded() {
    let (service, _) = service();
    let service = Arc::new(service);
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let service = service.clone();
            std::thread::spawn(move || {
                service
                    .dispatch(
                        "main",
                        Command::DataClear,
                        Some(json!({"requestId":"same-clear"})),
                    )
                    .changed
                    .is_some()
            })
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|thread| usize::from(thread.join().unwrap()))
            .sum::<usize>(),
        1
    );
    for n in 0..1_001 {
        service.dispatch(
            "main",
            Command::DataClear,
            Some(json!({"requestId":format!("clear-{n}")})),
        );
    }
    assert_eq!(service.state.lock().unwrap().receipts.len(), 1_000);
}
