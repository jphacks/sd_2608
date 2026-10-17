use crate::{
    ipc::dto::*,
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
}
pub struct AppService {
    state: Mutex<State>,
    clock: Arc<dyn Clock>,
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
        let now = SafeInt::try_from(clock.read().utc_ms).map_err(|_| internal())?;
        Ok(Self {
            state: Mutex::new(State {
                snapshot: AppSnapshot::initial(runtime_id, now),
                generation: 0,
                receipts: VecDeque::new(),
                fingerprinters: [RandomState::new(), RandomState::new()],
            }),
            clock,
        })
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
                Ok(request) => return self.mutate(
                    &mut state,
                    command,
                    request.request_id.clone(),
                    json!(request),
                    |state| {
                        if request.expected_settings_revision != state.snapshot.settings.revision {
                            return failure(ErrorCode::StaleRevision, "設定を読み直してください。");
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
                        failure(
                            ErrorCode::InvalidState,
                            "PC 情報と顔検出は未接続です。まだ監視を開始できません（B-02・B-03）。",
                        )
                    },
                ),
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

#[cfg(test)]
mod tests;
