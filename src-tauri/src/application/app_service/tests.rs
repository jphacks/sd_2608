use super::*;
use crate::ports::clock::ClockReading;

pub(super) struct FakeClock(pub(super) AtomicU64);
impl Clock for FakeClock {
    fn read(&self) -> ClockReading {
        ClockReading {
            utc_ms: self.0.load(Ordering::Relaxed),
            elapsed_ms: self.0.load(Ordering::Relaxed),
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
pub(super) fn snapshot(service: &AppService) -> AppSnapshot {
    match service
        .dispatch("main", Command::AppGetSnapshot, None)
        .result
    {
        ApiResult::Success(value) => serde_json::from_value(value).unwrap(),
        result => panic!("{result:?}"),
    }
}
pub(super) fn error_code(outcome: DispatchOutcome) -> ErrorCode {
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
    let start = json!({"requestId":"start","profile":"normal","expectedSettingsRevision":0,"reportMode":"ai",
        "consent":{"activity":true,"history":true,"externalReport":true}});
    assert_eq!(
        error_code(service.dispatch("main", Command::RuntimeStart, Some(start.clone()))),
        ErrorCode::ProviderNotConfigured
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

fn start_request(id: &str) -> Value {
    json!({"requestId":id,"profile":"normal","expectedSettingsRevision":0,"reportMode":"local",
        "consent":{"activity":true,"history":true,"externalReport":false}})
}
pub(super) fn external() -> crate::ports::activity::ActivityReading {
    crate::ports::activity::ActivityReading {
        idle_ms: Some(90_000),
        foreground: Foreground::External(crate::ports::activity::WindowInfo {
            window_id: "window-1".into(),
            process_id: u32::MAX,
            app_name: "editor.exe".into(),
            window_title: "private-document-title".into(),
        }),
    }
}

#[test]
fn foreground_changes_and_read_failures_clear_private_data_and_never_infer_away() {
    let (service, clock) = service();
    let mut state = service.state.lock().unwrap();
    state.snapshot.settings.excluded_apps = vec!["private.exe".into()];
    for foreground in [
        Foreground::Pet,
        Foreground::Excluded,
        Foreground::Restricted,
        Foreground::Unavailable,
    ] {
        let sample = ActivitySample {
            observed_at_ms: clock.read().utc_ms,
            elapsed_ms: clock.read().elapsed_ms,
            reading: external(),
        };
        apply_activity(&mut state, Ok(sample.clone()));
        assert!(matches!(
            state.activity.as_ref().unwrap().reading.foreground,
            Foreground::External(_)
        ));
        let mut next = sample;
        next.reading.foreground = foreground;
        apply_activity(&mut state, Ok(next));
        assert!(!format!("{:?}", state.activity).contains("private-document-title"));
        assert!(
            !serde_json::to_string(&state.snapshot)
                .unwrap()
                .contains("private-document-title")
        );
        assert_eq!(state.snapshot.presence.value, Presence::Unknown);
        assert!(state.snapshot.session.is_none());
        assert!(state.snapshot.reminder.is_none());
    }
    for name in ["PRIVATE.EXE", "LockApp.EXE"] {
        let mut sample = ActivitySample {
            observed_at_ms: 0,
            elapsed_ms: 0,
            reading: external(),
        };
        if let Foreground::External(window) = &mut sample.reading.foreground {
            window.app_name = name.into();
        }
        apply_activity(&mut state, Ok(sample));
        assert_eq!(
            state.activity.as_ref().unwrap().reading.foreground,
            Foreground::Excluded
        );
    }
    let sample = ActivitySample {
        observed_at_ms: 0,
        elapsed_ms: 0,
        reading: external(),
    };
    apply_activity(&mut state, Ok(sample.clone()));
    apply_activity(&mut state, Err(ActivityError::Unavailable));
    assert!(state.activity.is_none());
    assert_eq!(state.snapshot.runtime.activity, ActivityPhase::Error);
    apply_activity(&mut state, Ok(sample));
    assert_eq!(state.snapshot.runtime.activity, ActivityPhase::Running);
    assert_eq!(state.snapshot.presence.value, Presence::Unknown);
    let mut own = ActivitySample {
        observed_at_ms: 0,
        elapsed_ms: 0,
        reading: external(),
    };
    if let Foreground::External(window) = &mut own.reading.foreground {
        window.process_id = std::process::id();
    }
    apply_activity(&mut state, Ok(own));
    assert_eq!(
        state.activity.as_ref().unwrap().reading.foreground,
        Foreground::Pet
    );
    let mut missing_idle = ActivitySample {
        observed_at_ms: 0,
        elapsed_ms: 0,
        reading: external(),
    };
    missing_idle.reading.idle_ms = None;
    apply_activity(&mut state, Ok(missing_idle));
    assert_eq!(state.snapshot.runtime.activity, ActivityPhase::Error);
    assert_eq!(
        state.snapshot.presence.reason,
        PresenceReason::SensorUnavailable
    );
}

#[test]
fn latest_activity_expires_against_monotonic_clock() {
    let (service, clock) = service();
    let now = clock.read();
    service.state.lock().unwrap().activity = Some(ActivitySample {
        observed_at_ms: now.utc_ms,
        elapsed_ms: now.elapsed_ms,
        reading: external(),
    });
    assert!(service.latest_activity().is_some());
    clock.0.fetch_add(MAX_SAMPLE_AGE_MS + 1, Ordering::Relaxed);
    assert!(service.latest_activity().is_none());
    assert!(service.state.lock().unwrap().activity.is_none());
}

#[test]
fn start_requires_consent_is_idempotent_and_restart_rejects_late_samples_and_old_stop() {
    use std::sync::mpsc;
    use std::time::Duration;
    struct Source {
        started: mpsc::Sender<()>,
        results:
            Mutex<mpsc::Receiver<Result<crate::ports::activity::ActivityReading, ActivityError>>>,
    }
    impl ActivitySource for Source {
        fn read(
            &self,
            _: &[String],
        ) -> Result<crate::ports::activity::ActivityReading, ActivityError> {
            self.started.send(()).unwrap();
            self.results
                .lock()
                .unwrap()
                .recv()
                .unwrap_or(Err(ActivityError::Unavailable))
        }
    }
    let (began, reads) = mpsc::channel();
    let (send, results) = mpsc::channel();
    let (events, received) = mpsc::channel();
    let clock = Arc::new(FakeClock(AtomicU64::new(1_000)));
    let service = AppService::with_activity_source(
        clock,
        Id::try_from("test".to_string()).unwrap(),
        Arc::new(Source {
            started: began,
            results: Mutex::new(results),
        }),
    )
    .unwrap();
    let mut denied = start_request("denied");
    denied["consent"]["activity"] = json!(false);
    assert_eq!(
        error_code(service.dispatch("main", Command::RuntimeStart, Some(denied))),
        ErrorCode::ConsentRequired
    );
    assert!(reads.try_recv().is_err());
    let first = service.dispatch("main", Command::RuntimeStart, Some(start_request("first")));
    assert!(matches!(first.result, ApiResult::Success(_)));
    reads.recv_timeout(Duration::from_secs(2)).unwrap();
    let old = snapshot(&service).runtime.tracking_id.unwrap();
    assert_eq!(
        first.result,
        service
            .dispatch("main", Command::RuntimeStart, Some(start_request("first")))
            .result
    );
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::RuntimeStart,
            Some(start_request("duplicate"))
        )),
        ErrorCode::InvalidState
    );
    assert!(service.stop_for_lifecycle().unwrap().is_some());
    assert!(service.latest_activity().is_none());
    service.dispatch("main", Command::RuntimeStart, Some(start_request("second")));
    let current = snapshot(&service).runtime.tracking_id.unwrap();
    assert_ne!(old, current);
    service.set_snapshot_publisher(
        &current,
        Arc::new(move |snapshot| {
            let _ = events.send(snapshot.clone());
        }),
    );
    send.send(Ok(external())).unwrap();
    reads.recv_timeout(Duration::from_secs(2)).unwrap();
    // 旧 read が戻っても現在の入力・revision に採用されない。
    assert!(service.latest_activity().is_none());
    assert!(received.try_recv().is_err());
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::RuntimeStop,
            Some(json!({"requestId":"old-stop","trackingId":old}))
        )),
        ErrorCode::StaleTracking
    );
    send.send(Ok(external())).unwrap();
    let changed = received.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(changed.runtime.activity, ActivityPhase::Running);
    assert_eq!(changed.runtime.camera, CameraPhase::Waiting);
    assert_eq!(changed.presence.value, Presence::Unknown);
    assert!(service.latest_activity().is_some());
    assert!(
        !serde_json::to_string(&changed)
            .unwrap()
            .contains("private-document-title")
    );
    service.dispatch(
        "main",
        Command::DataClear,
        Some(json!({"requestId":"clear"})),
    );
    assert!(service.latest_activity().is_none());
    assert!(service.publisher.lock().unwrap().is_none());
    assert_eq!(snapshot(&service).runtime.phase, RuntimePhase::Stopped);
}

#[test]
fn face_submit_updates_camera_once_stays_unknown_and_is_invalidated_on_stop() {
    let (service, clock) = service();
    activate(&service);
    {
        let mut state = service.state.lock().unwrap();
        state.snapshot.runtime.profile = TimingProfile::Normal;
        state.snapshot.session = None;
        state.snapshot.reminder = None;
        state.snapshot.jobs.clear();
    }
    let request = json!({"trackingId":"tracking-1","sequence":1,"observedAt":clock.read().utc_ms,"source":"camera","kind":"sample","faceDetected":true});
    let first = service.dispatch("main", Command::FaceSubmit, Some(request.clone()));
    assert!(matches!(first.result, ApiResult::Success(_)));
    assert!(first.changed.is_some());
    let again = service.dispatch("main", Command::FaceSubmit, Some(request.clone()));
    assert_eq!(first.result, again.result);
    assert!(again.changed.is_none());
    let view = snapshot(&service);
    assert_eq!(view.runtime.camera, CameraPhase::Running);
    assert_eq!(view.presence.value, Presence::Unknown);
    assert!(view.session.is_none());
    assert!(view.reminder.is_none());
    assert!(view.jobs.is_empty());
    assert!(service.latest_face().unwrap().face_detected);
    let mut manual = request.clone();
    manual["source"] = json!("manual");
    manual["sequence"] = json!(2);
    assert_eq!(
        error_code(service.dispatch("main", Command::FaceSubmit, Some(manual))),
        ErrorCode::PermissionDenied
    );
    let mut stale = request.clone();
    stale["trackingId"] = json!("old");
    assert_eq!(
        error_code(service.dispatch("main", Command::FaceSubmit, Some(stale))),
        ErrorCode::StaleTracking
    );
    clock.0.fetch_add(5_001, Ordering::Relaxed);
    assert_eq!(snapshot(&service).runtime.camera, CameraPhase::Error);
    assert!(service.latest_face().is_none());
    service.stop_for_lifecycle().unwrap();
    assert!(service.state.lock().unwrap().face.latest.is_none());
    assert_eq!(
        error_code(service.dispatch("main", Command::FaceSubmit, Some(request))),
        ErrorCode::StaleTracking
    );
}
