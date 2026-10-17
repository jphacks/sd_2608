use super::activity_monitor::ActivityMonitor;
use super::face_input::{FaceIngress, FaceObservation};
mod history;
mod sitting;
use super::persistence::{Persistence, storage_error};
use crate::{
    infrastructure::NativeActivitySource,
    ipc::dto::*,
    ports::activity::{
        ActivityError, ActivitySample, ActivitySource, Foreground, MAX_SAMPLE_AGE_MS,
        is_excluded_app,
    },
    ports::clock::{Clock, SystemClock},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sitting::refresh_inputs;
use std::{
    collections::{VecDeque, hash_map::RandomState},
    hash::{BuildHasher, Hash, Hasher},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    AppGetSnapshot,
    RuntimeStart,
    RuntimeStop,
    FaceSubmit,
    ReminderRespond,
    SettingsUpdate,
    ReportList,
    ReportGet,
    ReportRetry,
    DataClear,
}
#[derive(Clone)]
struct Receipt {
    id: Id,
    command: Command,
    fingerprint: [u64; 2],
    result: ApiResult<Value>,
}
struct State {
    snapshot: AppSnapshot,
    generation: u64,
    receipts: VecDeque<Receipt>,
    fingerprinters: [RandomState; 2],
    activity: Option<ActivitySample>,
    face: FaceIngress,
    domain: Option<crate::domain::Engine>,
    activity_error: Option<ActivityError>,
    report_unavailable: bool,
    history: crate::domain::history::History,
    // B-06 の調整処理への接続点。予約・ジョブの代用にはせず最後の固定コピーのみ保持。
    requested_history: Option<HistorySnapshot>,
    // 離席が確定するまで、顔欠落開始時点の直近30分を一つだけ仮固定する。
    away_history_candidate: Option<(u64, u64, HistorySnapshot)>,
    persistence: Persistence,
}
type SnapshotPublisher = Arc<dyn Fn(&AppSnapshot) + Send + Sync>;
pub struct AppService {
    state: Arc<Mutex<State>>,
    clock: Arc<dyn Clock>,
    monitor: ActivityMonitor,
    publisher: Arc<Mutex<Option<SnapshotPublisher>>>,
}
pub struct DispatchOutcome {
    pub result: ApiResult<Value>,
    pub changed: Option<AppSnapshot>,
}

fn failure(code: ErrorCode, message: &str) -> ApiResult<Value> {
    ApiResult::Failure(ApiError::new(code, message))
}
fn internal() -> ApiError {
    ApiError::new(
        ErrorCode::Internal,
        "アプリの状態を更新できません。再起動してください。",
    )
}
fn parse<T: DeserializeOwned>(request: Option<Value>) -> Result<T, ApiError> {
    request
        .ok_or_else(ApiError::validation)
        .and_then(|value| serde_json::from_value(value).map_err(|_| ApiError::validation()))
}
fn response<T: Serialize>(value: T) -> ApiResult<Value> {
    match serde_json::to_value(value) {
        Ok(value) => ApiResult::Success(value),
        Err(_) => ApiResult::Failure(internal()),
    }
}
impl Default for AppService {
    fn default() -> Self {
        static INSTANCE: AtomicU64 = AtomicU64::new(0);
        let clock = Arc::new(SystemClock::default());
        let id = format!(
            "runtime-{}-{}-{}",
            std::process::id(),
            clock.read().utc_ms,
            INSTANCE.fetch_add(1, Ordering::Relaxed)
        );
        Self::with_clock(clock, Id::try_from(id).expect("bounded runtime id"))
            .expect("valid system clock")
    }
}
impl AppService {
    pub fn with_clock(clock: Arc<dyn Clock>, runtime_id: Id) -> Result<Self, ApiError> {
        Self::with_activity_source(clock, runtime_id, Arc::new(NativeActivitySource))
    }
    pub fn with_activity_source(
        clock: Arc<dyn Clock>,
        runtime_id: Id,
        source: Arc<dyn ActivitySource>,
    ) -> Result<Self, ApiError> {
        let now = SafeInt::try_from(clock.read().utc_ms).map_err(|_| internal())?;
        let state = Arc::new(Mutex::new(State {
            snapshot: AppSnapshot::initial(runtime_id, now),
            generation: 0,
            receipts: VecDeque::new(),
            fingerprinters: [RandomState::new(), RandomState::new()],
            activity: None,
            face: FaceIngress::default(),
            domain: None,
            activity_error: None,
            report_unavailable: false,
            history: Default::default(),
            requested_history: None,
            away_history_candidate: None,
            persistence: Persistence::default(),
        }));
        let publisher: Arc<Mutex<Option<SnapshotPublisher>>> = Arc::default();
        let weak_state = Arc::downgrade(&state);
        let worker_publisher = publisher.clone();
        let worker_clock = clock.clone();
        let monitor = ActivityMonitor::new(
            source,
            clock.clone(),
            Arc::new(move |generation, sample| {
                let Some(state) = weak_state.upgrade() else {
                    return;
                };
                let changed = {
                    let Ok(mut state) = state.lock() else {
                        return;
                    };
                    if state.generation != generation
                        || state.snapshot.runtime.phase != RuntimePhase::Running
                    {
                        return;
                    }
                    let now = worker_clock.read();
                    let Ok(revision) =
                        SafeInt::try_from(state.snapshot.revision.get().saturating_add(1))
                    else {
                        return;
                    };
                    let Ok(timestamp) = SafeInt::try_from(now.utc_ms) else {
                        return;
                    };
                    let sample = sample.and_then(|sample| {
                        if now
                            .elapsed_ms
                            .checked_sub(sample.elapsed_ms)
                            .is_none_or(|age| age > MAX_SAMPLE_AGE_MS)
                        {
                            Err(ActivityError::Stale)
                        } else {
                            Ok(sample)
                        }
                    });
                    apply_activity(&mut state, sample);
                    refresh_inputs(&mut state, now);
                    state.snapshot.revision = revision;
                    state.snapshot.emitted_at = timestamp;
                    state.snapshot.clone()
                };
                let callback = worker_publisher
                    .lock()
                    .ok()
                    .and_then(|publisher| publisher.clone());
                if let Some(callback) = callback {
                    callback(&changed);
                }
            }),
        );
        Ok(Self {
            state,
            clock,
            monitor,
            publisher,
        })
    }
    /// Tauri setup だけから呼ぶ。テスト・診断の既定コンストラクターはユーザーデータに触れない。
    pub fn initialize_storage(
        &self,
        repository: Arc<dyn crate::ports::storage::Repository>,
        secrets: Arc<dyn crate::ports::storage::SecretStore>,
    ) -> Result<(), ApiError> {
        let mut state = self.state.lock().map_err(|_| internal())?;
        if state.snapshot.runtime.phase != RuntimePhase::Stopped
            || state.snapshot.revision != SafeInt::ZERO
        {
            return Err(internal());
        }
        state.persistence = Persistence::open(repository, secrets, self.clock.read().utc_ms);
        state.snapshot.settings = state.persistence.settings_view();
        state.snapshot.warning = state.persistence.warning();
        Ok(())
    }
    /// 内部の Domain/履歴用。通常 IPC へシリアライズせず、古い入力も返さない。
    pub fn latest_activity(&self) -> Option<ActivitySample> {
        let mut state = self.state.lock().ok()?;
        let now = self.clock.read().elapsed_ms;
        if state.activity.as_ref().is_some_and(|sample| {
            now.checked_sub(sample.elapsed_ms)
                .is_none_or(|age| age > MAX_SAMPLE_AGE_MS)
        }) {
            state.activity = None;
            state.activity_error = Some(ActivityError::Stale);
        }
        state.activity.clone()
    }
    pub fn set_snapshot_publisher(&self, tracking_id: &Id, publisher: SnapshotPublisher) {
        if let Ok(state) = self.state.lock() {
            if state.snapshot.runtime.tracking_id.as_ref() == Some(tracking_id) {
                if let Ok(mut target) = self.publisher.lock() {
                    *target = Some(publisher);
                }
            }
        }
    }
    pub fn latest_face(&self) -> Option<FaceObservation> {
        let mut state = self.state.lock().ok()?;
        state.face.expire(self.clock.read().elapsed_ms);
        state.face.latest.clone()
    }
    pub fn dispatch(
        &self,
        window_label: &str,
        command: Command,
        request: Option<Value>,
    ) -> DispatchOutcome {
        let reject = |error| DispatchOutcome {
            result: ApiResult::Failure(error),
            changed: None,
        };
        if window_label != "main" {
            return reject(ApiError::new(
                ErrorCode::PermissionDenied,
                "このウィンドウからは操作できません。",
            ));
        }
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return reject(internal()),
        };
        let result =
            match command {
                Command::AppGetSnapshot => {
                    if request.is_some() {
                        Err(ApiError::validation())
                    } else {
                        if state.snapshot.runtime.phase != RuntimePhase::Running {
                            return DispatchOutcome {
                                result: response(&state.snapshot),
                                changed: None,
                            };
                        }
                        let now = self.clock.read();
                        let Ok(timestamp) = SafeInt::try_from(now.utc_ms) else {
                            return reject(internal());
                        };
                        let Ok(revision) =
                            SafeInt::try_from(state.snapshot.revision.get().saturating_add(1))
                        else {
                            return reject(internal());
                        };
                        let previous = (
                            state.snapshot.runtime.camera,
                            state.snapshot.presence.clone(),
                            state.snapshot.warning.clone(),
                            state.snapshot.session.clone(),
                            state.snapshot.reminder.clone(),
                            state.snapshot.runtime.activity,
                        );
                        if state.snapshot.runtime.phase == RuntimePhase::Running {
                            refresh_inputs(&mut state, now);
                        }
                        let changed = previous
                            != (
                                state.snapshot.runtime.camera,
                                state.snapshot.presence.clone(),
                                state.snapshot.warning.clone(),
                                state.snapshot.session.clone(),
                                state.snapshot.reminder.clone(),
                                state.snapshot.runtime.activity,
                            );
                        if changed {
                            state.snapshot.revision = revision;
                            state.snapshot.emitted_at = timestamp;
                        }
                        return DispatchOutcome {
                            result: response(&state.snapshot),
                            changed: changed.then(|| state.snapshot.clone()),
                        };
                    }
                }
                Command::ReportList => parse::<ListReportsRequest>(request).and_then(|request| {
                    let runtime = state.snapshot.runtime_id.clone();
                    state
                        .persistence
                        .list(&request, self.clock.read().utc_ms, &runtime)
                        .map(response)
                }),
                Command::ReportGet => parse::<GetReportRequest>(request).and_then(|request| {
                    state
                        .persistence
                        .get(&request.report_id, self.clock.read().utc_ms)
                        .map(response)
                }),
                Command::RuntimeStart => match parse::<StartRuntimeRequest>(request) {
                    Ok(request) => {
                        return self.mutate(
                            &mut state,
                            command,
                            request.request_id.clone(),
                            json!(request),
                            |state| {
                                if request.expected_settings_revision
                                    != state.snapshot.settings.revision
                                {
                                    return failure(
                                        ErrorCode::StaleRevision,
                                        "設定を読み直してください。",
                                    );
                                }
                                if !request.consent.activity
                                    || !request.consent.history
                                    || (request.report_mode == ReportMode::Ai
                                        && !request.consent.external_report)
                                {
                                    return failure(
                                        ErrorCode::ConsentRequired,
                                        "開始する機能の説明を確認してください。",
                                    );
                                }
                                match self.start(state, &request) {
                                    Ok(()) => response(&state.snapshot),
                                    Err(error) => ApiResult::Failure(error),
                                }
                            },
                        );
                    }
                    Err(error) => Err(error),
                },
                Command::FaceSubmit => match parse::<FaceInput>(request) {
                    Ok(input) => return self.submit_face(&mut state, input),
                    Err(error) => Err(error),
                },
                Command::ReminderRespond => match parse::<RespondReminderRequest>(request) {
                    Ok(request) => {
                        return self.mutate(
                            &mut state,
                            command,
                            request.request_id.clone(),
                            json!(request),
                            |state| self.respond(state, &request),
                        );
                    }
                    Err(error) => Err(error),
                },
                Command::SettingsUpdate => match parse::<UpdateSettingsRequest>(request) {
                    Ok(request) => {
                        return self.mutate(
                            &mut state,
                            command,
                            request.request_id.clone(),
                            json!(request),
                            |state| {
                                if state.snapshot.runtime.phase != RuntimePhase::Stopped {
                                    return failure(
                                        ErrorCode::InvalidState,
                                        "設定変更前に監視を停止してください。",
                                    );
                                }
                                let result = (|| {
                                    let revision = SafeInt::try_from(
                                        state
                                            .snapshot
                                            .revision
                                            .get()
                                            .checked_add(1)
                                            .ok_or_else(internal)?,
                                    )
                                    .map_err(|_| internal())?;
                                    let now = SafeInt::try_from(self.clock.read().utc_ms)
                                        .map_err(|_| internal())?;
                                    let settings = state.persistence.update(&request)?;
                                    state.snapshot.settings = settings;
                                    state.snapshot.revision = revision;
                                    state.snapshot.emitted_at = now;
                                    state.snapshot.warning = state.persistence.warning();
                                    Ok(state.snapshot.clone())
                                })();
                                match result {
                                    Ok(snapshot) => response(snapshot),
                                    Err(error) => ApiResult::Failure(error),
                                }
                            },
                        );
                    }
                    Err(error) => Err(error),
                },
                Command::ReportRetry => match parse::<RetryReportRequest>(request) {
                    Ok(request) => {
                        return self.mutate(
                            &mut state,
                            command,
                            request.request_id.clone(),
                            json!(request),
                            |_| {
                                failure(
                                    ErrorCode::InvalidState,
                                    "レポート生成は未接続です（B-06・B-07）。",
                                )
                            },
                        );
                    }
                    Err(error) => Err(error),
                },
                Command::RuntimeStop => match parse::<StopRuntimeRequest>(request) {
                    Ok(request) => return self.mutate(
                        &mut state,
                        command,
                        request.request_id.clone(),
                        json!(request),
                        |state| {
                            if state.snapshot.runtime.tracking_id.as_ref()
                                != Some(&request.tracking_id)
                            {
                                return failure(
                                    ErrorCode::StaleTracking,
                                    "この監視は停止済み、または新しい監視に切り替わっています。",
                                );
                            }
                            match self.reset(state, false) {
                                Ok(()) => response(&state.snapshot),
                                Err(error) => ApiResult::Failure(error),
                            }
                        },
                    ),
                    Err(error) => Err(error),
                },
                Command::DataClear => match parse::<ClearDataRequest>(request) {
                    Ok(request) => {
                        return self.mutate(
                            &mut state,
                            command,
                            request.request_id.clone(),
                            json!(request),
                            |state| {
                                if let Err(error) = self.reset(state, true) {
                                    return ApiResult::Failure(error);
                                }
                                match state.persistence.clear() {
                                    Ok(()) => response(&state.snapshot),
                                    Err(error) => {
                                        state.snapshot.warning = Some(error.clone());
                                        ApiResult::Failure(error)
                                    }
                                }
                            },
                        );
                    }
                    Err(error) => Err(error),
                },
            };
        DispatchOutcome {
            result: result.unwrap_or_else(ApiResult::Failure),
            changed: None,
        }
    }
    fn mutate<F>(
        &self,
        state: &mut State,
        command: Command,
        id: Id,
        request: Value,
        perform: F,
    ) -> DispatchOutcome
    where
        F: FnOnce(&mut State) -> ApiResult<Value>,
    {
        // 正規化した DTO の照合子だけを記録し、キーを含む要求本文を保持しない。
        let normalized = request.to_string();
        let fingerprint = state.fingerprinters.each_ref().map(|builder| {
            let mut hasher = builder.build_hasher();
            normalized.hash(&mut hasher);
            hasher.finish()
        });
        if let Some(receipt) = state.receipts.iter().find(|receipt| receipt.id == id) {
            return DispatchOutcome {
                changed: None,
                result: if receipt.command == command && receipt.fingerprint == fingerprint {
                    receipt.result.clone()
                } else {
                    ApiResult::Failure(ApiError::validation())
                },
            };
        }
        let revision = state.snapshot.revision;
        let result = perform(state);
        let changed = (revision != state.snapshot.revision).then(|| state.snapshot.clone());
        state.receipts.push_back(Receipt {
            id,
            command,
            fingerprint,
            result: result.clone(),
        });
        if state.receipts.len() > 1_000 {
            state.receipts.pop_front();
        }
        DispatchOutcome { result, changed }
    }
    fn reset(&self, state: &mut State, clear: bool) -> Result<(), ApiError> {
        let revision = state
            .snapshot
            .revision
            .get()
            .checked_add(1)
            .and_then(|n| SafeInt::try_from(n).ok())
            .ok_or_else(internal)?;
        let generation = state.generation.checked_add(1).ok_or_else(internal)?;
        let reading = self.clock.read();
        let now = SafeInt::try_from(reading.utc_ms).map_err(|_| internal())?;
        self.monitor.stop();
        if let Ok(mut publisher) = self.publisher.lock() {
            *publisher = None;
        }
        if let Some(engine) = state.domain.as_mut() {
            let events = engine.stop(crate::domain::Time {
                utc_ms: reading.utc_ms,
                elapsed_ms: reading.elapsed_ms,
            });
            sitting::handle_events(state, &events);
        }
        state.activity = None;
        state.face = FaceIngress::default();
        state.domain = None;
        state.activity_error = None;
        state.report_unavailable = false;
        state.history = Default::default();
        state.requested_history = None;
        state.away_history_candidate = None;
        state.generation = generation;
        state.snapshot.revision = revision;
        state.snapshot.emitted_at = now;
        state.snapshot.runtime = RuntimeState::stopped(state.snapshot.runtime.profile);
        state.snapshot.presence =
            AppSnapshot::initial(state.snapshot.runtime_id.clone(), now).presence;
        state.snapshot.session = None;
        state.snapshot.reminder = None;
        state.snapshot.warning = state.persistence.warning();
        if clear {
            state.snapshot.jobs.clear();
        } else {
            for job in &mut state.snapshot.jobs {
                if matches!(
                    job.status,
                    JobStatus::Scheduled | JobStatus::Queued | JobStatus::Running
                ) {
                    job.status = JobStatus::Cancelled;
                }
            }
        }
        Ok(())
    }
    fn start(&self, state: &mut State, request: &StartRuntimeRequest) -> Result<(), ApiError> {
        if state.snapshot.runtime.phase != RuntimePhase::Stopped {
            return Err(ApiError::new(
                ErrorCode::InvalidState,
                "停止してから開始し直してください。",
            ));
        }
        if state.persistence.warning().is_some() {
            return Err(storage_error());
        }
        if request.report_mode == ReportMode::Ai {
            return Err(ApiError::new(
                ErrorCode::ProviderNotConfigured,
                "AI レポートは未接続です（B-07）。ローカルモードを選んでください。",
            ));
        }
        let generation = state.generation.checked_add(1).ok_or_else(internal)?;
        let revision = SafeInt::try_from(
            state
                .snapshot
                .revision
                .get()
                .checked_add(1)
                .ok_or_else(internal)?,
        )
        .map_err(|_| internal())?;
        let now = SafeInt::try_from(self.clock.read().utc_ms).map_err(|_| internal())?;
        static TRACKING: Mutex<u64> = Mutex::new(0);
        let serial = {
            let mut serial = TRACKING.lock().map_err(|_| internal())?;
            *serial = serial.checked_add(1).ok_or_else(internal)?;
            *serial
        };
        let tracking_id = Id::try_from(format!(
            "tracking-{}-{}-{}",
            std::process::id(),
            now.get(),
            serial
        ))
        .map_err(|_| internal())?;
        self.monitor
            .start(generation, state.snapshot.settings.excluded_apps.clone())
            .map_err(|_| ApiError::new(ErrorCode::Internal, "PC 情報の取得を開始できません。"))?;
        state.generation = generation;
        state.activity = None;
        state.snapshot.revision = revision;
        state.snapshot.emitted_at = now;
        state.snapshot.runtime = RuntimeState {
            phase: RuntimePhase::Running,
            tracking_id: Some(tracking_id),
            profile: request.profile,
            effective_report_mode: ReportMode::Local,
            camera: CameraPhase::Waiting,
            activity: ActivityPhase::Running,
            consent: request.consent.clone(),
        };
        state.snapshot.presence =
            AppSnapshot::initial(state.snapshot.runtime_id.clone(), now).presence;
        state.face = FaceIngress::default();
        state.domain = Some(crate::domain::Engine::new(sitting::timings(
            request.profile,
        )));
        state.activity_error = None;
        state.report_unavailable = false;
        refresh_inputs(state, self.clock.read());
        Ok(())
    }
    fn submit_face(&self, state: &mut State, input: FaceInput) -> DispatchOutcome {
        let result = (|| {
            if state.snapshot.runtime.phase != RuntimePhase::Running
                || state.snapshot.runtime.tracking_id.as_ref() != Some(input.tracking_id())
            {
                return Err(ApiError::new(
                    ErrorCode::StaleTracking,
                    "有効な監視の顔入力ではありません。",
                ));
            }
            let now = self.clock.read();
            let timestamp = SafeInt::try_from(now.utc_ms).map_err(|_| internal())?;
            let revision = SafeInt::try_from(state.snapshot.revision.get().saturating_add(1))
                .map_err(|_| internal())?;
            let normalized = serde_json::to_string(&input).map_err(|_| internal())?;
            let fingerprint = state.fingerprinters.each_ref().map(|builder| {
                let mut hasher = builder.build_hasher();
                normalized.hash(&mut hasher);
                hasher.finish()
            });
            let (receipt, changed) = state.face.accept(
                &input,
                fingerprint,
                now,
                state.snapshot.runtime.profile,
                revision,
            )?;
            if changed {
                refresh_inputs(state, now);
                state.snapshot.revision = revision;
                state.snapshot.emitted_at = timestamp;
            }
            Ok((receipt, changed))
        })();
        match result {
            Ok((receipt, changed)) => DispatchOutcome {
                result: response(receipt),
                changed: changed.then(|| state.snapshot.clone()),
            },
            Err(error) => DispatchOutcome {
                result: ApiResult::Failure(error),
                changed: None,
            },
        }
    }
    fn respond(&self, state: &mut State, request: &RespondReminderRequest) -> ApiResult<Value> {
        let result = (|| {
            if state.snapshot.runtime.phase != RuntimePhase::Running {
                return Err(ApiError::new(
                    ErrorCode::StaleReminder,
                    "回答できる休憩通知はありません。",
                ));
            }
            if state.snapshot.runtime.tracking_id.as_ref() != Some(&request.tracking_id) {
                return Err(ApiError::new(
                    ErrorCode::StaleTracking,
                    "監視が更新されています。",
                ));
            }
            let now = self.clock.read();
            let timestamp = SafeInt::try_from(now.utc_ms).map_err(|_| internal())?;
            let revision = SafeInt::try_from(state.snapshot.revision.get().saturating_add(1))
                .map_err(|_| internal())?;
            let before = state.snapshot.clone();
            refresh_inputs(state, now);
            if before != state.snapshot {
                state.snapshot.revision = revision;
                state.snapshot.emitted_at = timestamp;
            }
            if state.snapshot.reminder.as_ref().is_none_or(|reminder| {
                reminder.id != request.reminder_id || reminder.session_id != request.session_id
            }) {
                return Err(ApiError::new(
                    ErrorCode::StaleReminder,
                    "この休憩通知は回答済み、または失効しています。",
                ));
            }
            let revision = SafeInt::try_from(state.snapshot.revision.get().saturating_add(1))
                .map_err(|_| internal())?;
            let engine = state.domain.as_mut().ok_or_else(internal)?;
            let reminder = engine.visible_reminder().cloned().ok_or_else(internal)?;
            let events = engine
                .answer(
                    reminder.session_id,
                    reminder.id,
                    match request.answer {
                        Answer::Yes => crate::domain::Answer::Yes,
                        Answer::No => crate::domain::Answer::No,
                    },
                    crate::domain::Time {
                        utc_ms: now.utc_ms,
                        elapsed_ms: now.elapsed_ms,
                    },
                )
                .map_err(|_| {
                    ApiError::new(ErrorCode::StaleReminder, "この休憩通知は失効しています。")
                })?;
            sitting::handle_events(state, &events);
            sitting::project(state);
            state.snapshot.revision = revision;
            state.snapshot.emitted_at = timestamp;
            // B-06 未接続：回答だけを受け付け、ジョブ・カードの作成成功を返さない。
            Ok(RespondReminderResult {
                snapshot: state.snapshot.clone(),
                report_id: None,
            })
        })();
        match result {
            Ok(value) => response(value),
            Err(error) => ApiResult::Failure(error),
        }
    }
    pub fn stop_for_lifecycle(&self) -> Result<Option<AppSnapshot>, ApiError> {
        let mut state = self.state.lock().map_err(|_| internal())?;
        let active = state.snapshot.runtime.phase != RuntimePhase::Stopped
            || state.snapshot.jobs.iter().any(|job| {
                matches!(
                    job.status,
                    JobStatus::Scheduled | JobStatus::Queued | JobStatus::Running
                )
            });
        if !active {
            return Ok(None);
        }
        self.reset(&mut state, false)?;
        Ok(Some(state.snapshot.clone()))
    }
}

fn apply_activity(state: &mut State, sample: Result<ActivitySample, ActivityError>) {
    state.activity = None;
    state.snapshot.presence.value = Presence::Unknown;
    state.snapshot.presence.face_missing_since = None;
    state.snapshot.presence.away_detected_at = None;
    match sample {
        Ok(mut sample) => {
            // ポート実装の差替え時にも除外情報を保持しない。
            if let Foreground::External(window) = &sample.reading.foreground {
                if window.process_id == std::process::id() {
                    sample.reading.foreground = Foreground::Pet;
                } else if is_excluded_app(&window.app_name, &state.snapshot.settings.excluded_apps)
                {
                    sample.reading.foreground = Foreground::Excluded;
                }
            }
            let unavailable = sample.reading.idle_ms.is_none()
                || sample.reading.foreground == Foreground::Unavailable;
            state.activity_error = unavailable.then_some(ActivityError::Unavailable);
            state.snapshot.runtime.activity = if unavailable {
                ActivityPhase::Error
            } else {
                ActivityPhase::Running
            };
            state.snapshot.presence.reason = match sample.reading.foreground {
                Foreground::Restricted => PresenceReason::ProtectedScreen,
                Foreground::Unavailable => PresenceReason::SensorUnavailable,
                _ if sample.reading.idle_ms.is_none() => PresenceReason::SensorUnavailable,
                _ => PresenceReason::MissingInput,
            };
            // タイトルは現在の1サンプルだけに保持。pet/除外/ロック/取得不可への変化で消える。
            state.activity = Some(sample);
        }
        Err(error) => {
            state.activity_error = Some(error);
            state.snapshot.runtime.activity = ActivityPhase::Error;
            state.snapshot.presence.reason = if error == ActivityError::Stale {
                PresenceReason::StaleSample
            } else {
                PresenceReason::SensorUnavailable
            };
            state.snapshot.warning = Some(activity_unavailable());
        }
    }
}
fn activity_unavailable() -> ApiError {
    ApiError::new(
        ErrorCode::Internal,
        "PC 情報の全部または一部を取得できません。在席は判定できません。停止・再開で取得し直せます。",
    )
}

#[cfg(test)]
mod sitting_tests;
#[cfg(test)]
mod storage_tests;
#[cfg(test)]
mod tests;
