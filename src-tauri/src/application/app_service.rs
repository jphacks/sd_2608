use super::activity_monitor::ActivityMonitor;
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
    /// 内部の Domain/履歴用。通常 IPC へシリアライズせず、古い入力も返さない。
    pub fn latest_activity(&self) -> Option<ActivitySample> {
        let mut state = self.state.lock().ok()?;
        let now = self.clock.read().elapsed_ms;
        if state.activity.as_ref().is_some_and(|sample| {
            now.checked_sub(sample.elapsed_ms)
                .is_none_or(|age| age > MAX_SAMPLE_AGE_MS)
        }) {
            state.activity = None;
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
        let result = match command {
            Command::AppGetSnapshot => {
                if request.is_some() {
                    Err(ApiError::validation())
                } else {
                    Ok(response(&state.snapshot))
                }
            }
            Command::ReportList => parse::<ListReportsRequest>(request).and_then(|request| {
                if !(1..=20).contains(&request.limit.get()) || request.cursor.is_some() {
                    return Err(ApiError::validation());
                }
                Ok(response(ReportPage {
                    items: vec![],
                    next_cursor: None,
                }))
            }),
            Command::ReportGet => parse::<GetReportRequest>(request)
                .map(|_| failure(ErrorCode::NotFound, "レポートがありません。")),
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
            Command::FaceSubmit => parse::<FaceInput>(request)
                .map(|_| failure(ErrorCode::StaleTracking, "有効な監視は開始されていません。")),
            Command::ReminderRespond => match parse::<RespondReminderRequest>(request) {
                Ok(request) => {
                    return self.mutate(
                        &mut state,
                        command,
                        request.request_id.clone(),
                        json!(request),
                        |_| failure(ErrorCode::StaleReminder, "回答できる休憩通知はありません。"),
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
                        |_| failure(ErrorCode::InvalidState, "設定の保存は未接続です（B-05）。"),
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
            Command::RuntimeStop => {
                match parse::<StopRuntimeRequest>(request) {
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
                }
            }
            Command::DataClear => match parse::<ClearDataRequest>(request) {
                Ok(request) => {
                    return self.mutate(
                        &mut state,
                        command,
                        request.request_id.clone(),
                        json!(request),
                        |state| match self.reset(state, true) {
                            Ok(()) => response(&state.snapshot),
                            Err(error) => ApiResult::Failure(error),
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
        let now = SafeInt::try_from(self.clock.read().utc_ms).map_err(|_| internal())?;
        self.monitor.stop();
        if let Ok(mut publisher) = self.publisher.lock() {
            *publisher = None;
        }
        state.activity = None;
        state.generation = generation;
        state.snapshot.revision = revision;
        state.snapshot.emitted_at = now;
        state.snapshot.runtime = RuntimeState::stopped(state.snapshot.runtime.profile);
        state.snapshot.presence =
            AppSnapshot::initial(state.snapshot.runtime_id.clone(), now).presence;
        state.snapshot.session = None;
        state.snapshot.reminder = None;
        state.snapshot.warning = None;
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
            camera: CameraPhase::Off,
            activity: ActivityPhase::Running,
            consent: request.consent.clone(),
        };
        state.snapshot.presence =
            AppSnapshot::initial(state.snapshot.runtime_id.clone(), now).presence;
        state.snapshot.warning = Some(camera_pending());
        Ok(())
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

fn camera_pending() -> ApiError {
    ApiError::new(
        ErrorCode::InvalidState,
        "PC 情報のみ取得中です。顔検出・在席判定・履歴保存・休憩通知は未接続です（B-03〜06）。",
    )
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
            state.snapshot.warning = Some(if unavailable {
                activity_unavailable()
            } else {
                camera_pending()
            });
            // タイトルは現在の1サンプルだけに保持。pet/除外/ロック/取得不可への変化で消える。
            state.activity = Some(sample);
        }
        Err(error) => {
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
mod tests;
