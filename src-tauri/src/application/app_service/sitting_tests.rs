use super::tests::{FakeClock, error_code, external, snapshot};
use super::*;
pub(super) struct Rig {
    pub(super) service: AppService,
    pub(super) clock: Arc<FakeClock>,
    sequence: u64,
}
impl Rig {
    pub(super) fn new() -> Self {
        Self::with_provider(Arc::new(
            crate::infrastructure::providers::HttpReportProvider::default(),
        ))
    }
    pub(super) fn with_provider(
        provider: Arc<dyn crate::ports::report_provider::ReportProvider>,
    ) -> Self {
        struct TestSource;
        impl ActivitySource for TestSource {
            fn read(
                &self,
                _: &[String],
            ) -> Result<crate::ports::activity::ActivityReading, ActivityError> {
                Err(ActivityError::Unavailable)
            }
        }
        let clock = Arc::new(FakeClock(AtomicU64::new(1_000_000)));
        let service = AppService::with_report_provider(
            clock.clone(),
            Id::try_from("sitting-test".to_string()).unwrap(),
            Arc::new(TestSource),
            provider,
        )
        .unwrap();
        {
            let mut state = service.state.lock().unwrap();
            state.snapshot.runtime.phase = RuntimePhase::Running;
            state.snapshot.runtime.profile = TimingProfile::Demo;
            state.snapshot.runtime.tracking_id =
                Some(Id::try_from("sitting-tracking".to_string()).unwrap());
            state.snapshot.runtime.activity = ActivityPhase::Running;
            state.snapshot.runtime.camera = CameraPhase::Waiting;
            state.snapshot.runtime.consent = Consent {
                activity: true,
                history: true,
                external_report: false,
            };
            state.domain = Some(crate::domain::Engine::new(
                crate::domain::timings::Timings::DEMO,
            ));
        }
        Self {
            service,
            clock,
            sequence: 0,
        }
    }
    pub(super) fn step(&mut self, ms: u64, detected: bool, idle: u64) -> Value {
        self.clock.0.fetch_add(ms, Ordering::Relaxed);
        self.sequence += 1;
        let now = self.clock.read();
        {
            let mut state = self.service.state.lock().unwrap();
            let mut reading = external();
            reading.idle_ms = Some(idle);
            apply_activity(
                &mut state,
                Ok(ActivitySample {
                    observed_at_ms: now.utc_ms,
                    elapsed_ms: now.elapsed_ms,
                    reading,
                }),
            );
        }
        let input = json!({"trackingId":"sitting-tracking","sequence":self.sequence,"observedAt":now.utc_ms,"source":"manual","kind":"sample","faceDetected":detected});
        assert!(matches!(
            self.service
                .dispatch("main", Command::FaceSubmit, Some(input.clone()))
                .result,
            ApiResult::Success(_)
        ));
        input
    }
    pub(super) fn run(&mut self, seconds: u64, detected: bool, idle: u64) {
        for _ in 0..seconds {
            self.step(1_000, detected, idle);
        }
    }
    pub(super) fn stable(&mut self) {
        self.run(5, true, 0);
        assert_eq!(snapshot(&self.service).presence.value, Presence::Present);
    }
    pub(super) fn answer_request(&self, id: &str, answer: &str) -> Value {
        let view = snapshot(&self.service);
        let reminder = view.reminder.unwrap();
        json!({"requestId":id,"trackingId":view.runtime.tracking_id.unwrap(),"sessionId":reminder.session_id,"reminderId":reminder.id,"answer":answer})
    }
    pub(super) fn answer(&self, request: Value) -> DispatchOutcome {
        self.service
            .dispatch("main", Command::ReminderRespond, Some(request))
    }
}
#[test]
fn live_samples_reach_a_demo_prompt_and_no_is_idempotent_without_a_report() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(34, true, 0);
    assert!(snapshot(&rig.service).reminder.is_none());
    rig.step(1_000, true, 0);
    let view = snapshot(&rig.service);
    assert_eq!(
        view.reminder.as_ref().unwrap().cause,
        ReminderCause::InitialLimit
    );
    assert!(view.warning.unwrap().message.contains("手動テスト"));
    assert!(
        !serde_json::to_string(&snapshot(&rig.service))
            .unwrap()
            .contains("private-document-title")
    );
    let request = rig.answer_request("no-1", "no");
    let first = rig.answer(request.clone());
    let again = rig.answer(request.clone());
    assert_eq!(first.result, again.result);
    assert!(first.changed.is_some());
    assert!(again.changed.is_none());
    let mut changed = request.clone();
    changed["answer"] = json!("yes");
    assert_eq!(error_code(rig.answer(changed)), ErrorCode::Validation);
    rig.run(9, true, 0);
    assert!(snapshot(&rig.service).reminder.is_none());
    rig.step(1_000, true, 0);
    assert!(snapshot(&rig.service).reminder.is_some());
    assert!(snapshot(&rig.service).jobs.is_empty());
    let mut old = request;
    old["requestId"] = json!("new-request-old-reminder");
    assert_eq!(error_code(rig.answer(old)), ErrorCode::StaleReminder);
}
#[test]
fn yes_registers_one_job_without_resetting_the_sitting_clock() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(35, true, 0);
    let original = snapshot(&rig.service).session.unwrap();
    let first = rig.answer(rig.answer_request("yes-1", "yes"));
    let ApiResult::Success(value) = first.result else {
        panic!("expected accepted answer");
    };
    assert!(value["reportId"].is_string());
    assert_eq!(value["snapshot"]["jobs"].as_array().unwrap().len(), 1);
    let frozen = rig
        .service
        .state
        .lock()
        .unwrap()
        .requested_history
        .clone()
        .unwrap();
    assert_eq!(frozen.session_id, original.id);
    assert!(!frozen.segments.is_empty());
    assert!(
        frozen
            .segments
            .iter()
            .all(|segment| segment.ended_at <= frozen.range_end)
    );
    let after = snapshot(&rig.service);
    assert_eq!(after.session.as_ref().unwrap().id, original.id);
    assert_eq!(
        after.session.as_ref().unwrap().elapsed_ms,
        original.elapsed_ms
    );
    assert_eq!(after.jobs[0].status, JobStatus::Queued);
    rig.run(9, true, 0);
    assert!(snapshot(&rig.service).reminder.is_none());
    rig.step(1_000, true, 0);
    assert!(snapshot(&rig.service).reminder.is_some());
    rig.step(1_000, false, 60_000);
    rig.run(5, false, 60_000);
    assert_eq!(snapshot(&rig.service).presence.value, Presence::Away);
    assert!(snapshot(&rig.service).reminder.is_none());
    assert_eq!(snapshot(&rig.service).jobs.len(), 1);
    assert_eq!(
        rig.service.state.lock().unwrap().requested_history.as_ref(),
        Some(&frozen)
    );
}
#[test]
fn natural_away_freezes_at_first_missing_and_stop_clears_uncommitted_history() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(10, true, 0);
    rig.step(1000, false, 60_000);
    let first_missing = rig.clock.read().utc_ms;
    rig.run(5, false, 60_000);
    let frozen = rig
        .service
        .state
        .lock()
        .unwrap()
        .requested_history
        .clone()
        .unwrap();
    assert_eq!(frozen.range_end.get(), first_missing);
    assert!(
        frozen
            .segments
            .iter()
            .all(|segment| segment.ended_at.get() <= first_missing)
    );
    rig.run(5, true, 0);
    rig.run(10, true, 0);
    assert_eq!(
        rig.service.state.lock().unwrap().requested_history.as_ref(),
        Some(&frozen)
    );
    rig.service.stop_for_lifecycle().unwrap();
    let state = rig.service.state.lock().unwrap();
    assert!(state.history.session_id.is_none());
    assert!(state.requested_history.is_none());
}
#[test]
fn away_confirmation_does_not_lose_the_first_seconds_of_the_frozen_thirty_minutes() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(1900, true, 0);
    rig.step(1000, false, 60_000);
    let first_missing = rig.clock.read().utc_ms;
    rig.run(5, false, 60_000);
    let state = rig.service.state.lock().unwrap();
    let frozen = state.requested_history.as_ref().unwrap();
    assert_eq!(
        frozen.range_start.get(),
        first_missing - crate::domain::history::RETENTION_MS
    );
    assert_eq!(
        frozen.segments.first().unwrap().started_at,
        frozen.range_start
    );
    assert_eq!(frozen.range_end.get(), first_missing);
}
#[test]
fn distinct_votes_cannot_be_created_by_snapshot_reads_or_retried_face_inputs() {
    let mut rig = Rig::new();
    let input = rig.step(1_000, true, 0);
    for _ in 0..10 {
        assert!(
            rig.service
                .dispatch("main", Command::FaceSubmit, Some(input.clone()))
                .changed
                .is_none()
        );
        assert_eq!(snapshot(&rig.service).presence.value, Presence::Uncertain);
    }
    rig.run(3, true, 0);
    assert_eq!(snapshot(&rig.service).presence.value, Presence::Uncertain);
    rig.step(1_000, true, 0);
    assert_eq!(snapshot(&rig.service).presence.value, Presence::Present);
}
#[test]
fn sensor_expiry_invalidates_an_answer_before_the_next_worker_sample() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(35, true, 0);
    let request = rig.answer_request("late-no", "no");
    rig.clock.0.fetch_add(5_001, Ordering::Relaxed);
    assert!(rig.service.latest_activity().is_none());
    let outcome = rig.answer(request);
    assert_eq!(
        error_code(DispatchOutcome {
            result: outcome.result,
            changed: None
        }),
        ErrorCode::StaleReminder
    );
    assert!(outcome.changed.is_some());
    let view = snapshot(&rig.service);
    assert_eq!(view.presence.value, Presence::Unknown);
    assert!(view.reminder.is_none());
    assert_eq!(
        view.session.unwrap().end_reason,
        Some(EndReason::Interrupted)
    );
    rig.run(5, true, 0);
    assert_eq!(snapshot(&rig.service).session.unwrap().elapsed_ms.get(), 0);
}
#[test]
fn transient_face_loss_hides_a_prompt_and_old_tracking_is_rejected_after_stop() {
    let mut rig = Rig::new();
    rig.stable();
    rig.run(35, true, 0);
    let request = rig.answer_request("hidden-no", "no");
    let id = snapshot(&rig.service).reminder.unwrap().id;
    rig.step(1_000, false, 0);
    assert_eq!(error_code(rig.answer(request)), ErrorCode::StaleReminder);
    rig.step(1_000, true, 0);
    assert_eq!(snapshot(&rig.service).reminder.unwrap().id, id);
    let request = rig.answer_request("stopped-no", "no");
    rig.service.stop_for_lifecycle().unwrap();
    assert_eq!(error_code(rig.answer(request)), ErrorCode::StaleReminder);
    let mut state = rig.service.state.lock().unwrap();
    assert!(state.domain.is_none());
    assert!(state.snapshot.reminder.is_none());
    state.snapshot.runtime.phase = RuntimePhase::Running;
    state.snapshot.runtime.tracking_id = Some(Id::try_from("new-tracking".to_string()).unwrap());
    drop(state);
    assert_eq!(error_code(rig.answer(json!({"requestId":"old-tracking","trackingId":"sitting-tracking","sessionId":"missing","reminderId":"missing","answer":"yes"}))), ErrorCode::StaleTracking);
}
