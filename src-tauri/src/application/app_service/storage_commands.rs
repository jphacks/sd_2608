//! 保存用のロックを待つ間、センサーや snapshot の状態ロックを保持しない。
use super::*;
use crate::application::report_coordinator::Input;
use crate::domain::{self as d, report::Status};
enum Request {
    Settings(UpdateSettingsRequest),
    Clear,
    Retry(RetryReportRequest),
}
impl AppService {
    pub(super) fn cached(
        &self,
        state: &State,
        command: Command,
        id: &Id,
        request: &Value,
    ) -> Option<DispatchOutcome> {
        let receipt = state.receipts.iter().find(|receipt| receipt.id == *id)?;
        let fingerprint = fingerprint(state, request);
        Some(DispatchOutcome {
            changed: None,
            result: if receipt.command == command && receipt.fingerprint == fingerprint {
                receipt.result.clone()
            } else {
                ApiResult::Failure(ApiError::validation())
            },
        })
    }
    pub(super) fn storage_dispatch(
        &self,
        command: Command,
        request: Option<Value>,
    ) -> DispatchOutcome {
        let run = || -> Result<DispatchOutcome, ApiError> {
            if command == Command::ReportList {
                let request = parse::<ListReportsRequest>(request)?;
                let runtime = self
                    .state
                    .lock()
                    .map_err(|_| internal())?
                    .snapshot
                    .runtime_id
                    .clone();
                let page = self.persistence.lock().map_err(|_| internal())?.list(
                    &request,
                    self.clock.read().utc_ms,
                    &runtime,
                )?;
                return Ok(DispatchOutcome {
                    result: response(page),
                    changed: None,
                });
            }
            if command == Command::ReportGet {
                let request = parse::<GetReportRequest>(request)?;
                let card = self
                    .persistence
                    .lock()
                    .map_err(|_| internal())?
                    .get(&request.report_id, self.clock.read().utc_ms)?;
                return Ok(DispatchOutcome {
                    result: response(card),
                    changed: None,
                });
            }
            let (request, id, value) = match command {
                Command::SettingsUpdate => {
                    let r: UpdateSettingsRequest = parse(request)?;
                    let id = r.request_id.clone();
                    let value = json!(r);
                    (Request::Settings(r), id, value)
                }
                Command::DataClear => {
                    let r: ClearDataRequest = parse(request)?;
                    let id = r.request_id.clone();
                    let value = json!(r);
                    (Request::Clear, id, value)
                }
                Command::ReportRetry => {
                    let r: RetryReportRequest = parse(request)?;
                    let id = r.request_id.clone();
                    let value = json!(r);
                    (Request::Retry(r), id, value)
                }
                _ => unreachable!(),
            };
            let mut state = self.state.lock().map_err(|_| internal())?;
            if let Some(cached) = self.cached(&state, command, &id, &value) {
                return Ok(cached);
            }
            let previous = state.snapshot.revision;
            state.inflight = Some(id.clone());
            drop(state);
            let result: Result<(), ApiError> = match request {
                Request::Settings(request) => (|| {
                    let mut state = self.state.lock().map_err(|_| internal())?;
                    if state.snapshot.runtime.phase != RuntimePhase::Stopped {
                        return Err(ApiError::new(
                            ErrorCode::InvalidState,
                            "設定を変更する前に、作業の記録を停止してください。",
                        ));
                    }
                    if request.expected_settings_revision != state.snapshot.settings.revision {
                        return Err(ApiError::new(
                            ErrorCode::StaleRevision,
                            "設定を読み直してください。",
                        ));
                    }
                    let revision = SafeInt::try_from(
                        state
                            .snapshot
                            .revision
                            .get()
                            .checked_add(1)
                            .ok_or_else(internal)?,
                    )
                    .map_err(|_| internal())?;
                    let now =
                        SafeInt::try_from(self.clock.read().utc_ms).map_err(|_| internal())?;
                    drop(state);
                    let (result, warning, secret_id) = {
                        let mut store = self.persistence.lock().map_err(|_| internal())?;
                        let result = store.update(&request);
                        (result, store.warning(), store.secret_id())
                    };
                    state = self.state.lock().map_err(|_| internal())?;
                    let settings = result?;
                    state.snapshot.settings = settings;
                    state.secret_id = secret_id;
                    state.persistence_warning = warning.clone();
                    state.snapshot.warning = warning;
                    state.snapshot.revision = revision;
                    state.snapshot.emitted_at = now;
                    Ok(())
                })(),
                Request::Clear => (|| {
                    let mut state = self.state.lock().map_err(|_| internal())?;
                    self.reset(&mut state, true)?;
                    drop(state);
                    let (result, warning) = {
                        let mut store = self.persistence.lock().map_err(|_| internal())?;
                        let result = store.clear();
                        (result, store.warning())
                    };
                    state = self.state.lock().map_err(|_| internal())?;
                    let previous_warning = state.snapshot.warning.clone();
                    state.persistence_warning = warning.clone();
                    state.snapshot.warning = warning;
                    if let Err(error) = &result {
                        state.snapshot.warning = Some(error.clone());
                    }
                    if state.snapshot.warning != previous_warning {
                        reports::bump(&mut state, self.clock.read().utc_ms)?;
                    }
                    result
                })(),
                Request::Retry(request) => (|| {
                    let mut state = self.state.lock().map_err(|_| internal())?;
                    retry_allowed(&state)?;
                    let generation = state.generation;
                    drop(state);
                    let result = self
                        .persistence
                        .lock()
                        .map_err(|_| internal())?
                        .get(&request.report_id, self.clock.read().utc_ms);
                    state = self.state.lock().map_err(|_| internal())?;
                    retry_allowed(&state)?;
                    if state.generation != generation {
                        return Err(ApiError::new(
                            ErrorCode::StaleTracking,
                            "記録の状態が変わりました。もう一度操作してください。",
                        ));
                    }
                    let report = result?;
                    if report.status != ReportStatus::Failed
                        || report.attempt != request.expected_attempt
                    {
                        return Err(ApiError::new(
                            ErrorCode::InvalidState,
                            "失敗した最新の試行だけを再実行できます。",
                        ));
                    }
                    let now = self.clock.read();
                    if now.utc_ms > MAX_SAFE_INTEGER
                        || state.snapshot.revision.get() >= MAX_SAFE_INTEGER
                        || request.expected_attempt.get() >= MAX_SAFE_INTEGER
                    {
                        return Err(internal());
                    }
                    let at = d::Time {
                        utc_ms: now.utc_ms,
                        elapsed_ms: now.elapsed_ms,
                    };
                    let job_id = request.report_id.as_str();
                    if let Some(job) = state.reports.queue.jobs.iter().find(|job| job.id == job_id)
                    {
                        if job.status != Status::Failed
                            || job.attempt != request.expected_attempt.get()
                        {
                            return Err(ApiError::new(
                                ErrorCode::InvalidState,
                                "実行中・完成済み・取消済みのレポートは再実行できません。",
                            ));
                        }
                    } else {
                        if state
                            .reports
                            .queue
                            .for_session(report.session_id.as_str())
                            .is_some()
                        {
                            return Err(ApiError::new(
                                ErrorCode::InvalidState,
                                "このセッションのジョブは登録済みです。",
                            ));
                        }
                        let job = state.reports.queue.register(
                            job_id.into(),
                            report.session_id.as_str().into(),
                            match report.trigger {
                                ReportTrigger::Yes => d::ReportTrigger::Yes,
                                ReportTrigger::Away => d::ReportTrigger::Away,
                            },
                            at,
                            0,
                            generation,
                        );
                        let _ = job;
                        let job = state.reports.queue.jobs.last_mut().unwrap();
                        job.status = Status::Failed;
                        job.attempt = report.attempt.get();
                    }
                    let input = Input {
                        history: report.history.clone(),
                        settings: state.snapshot.settings.clone(),
                        consent: state.snapshot.runtime.consent.clone(),
                        mode: state.snapshot.runtime.effective_report_mode,
                        secret_id: state.secret_id.clone(),
                        created_at: Some(report.created_at),
                    };
                    if !state.reports.queue.retry(
                        job_id,
                        request.expected_attempt.get(),
                        at,
                        generation,
                    ) {
                        return Err(internal());
                    }
                    state.reports.inputs.insert(job_id.into(), input);
                    state.report_error = None;
                    self.report_worker.start()?;
                    reports::project(&mut state);
                    reports::bump(&mut state, now.utc_ms)?;
                    state.report_wake.notify();
                    Ok(())
                })(),
            };
            let mut state = self.state.lock().map_err(|_| internal())?;
            state.inflight = None;
            let result = match result {
                Ok(()) => response(&state.snapshot),
                Err(error) => ApiResult::Failure(error),
            };
            let mut outcome = self.mutate(&mut state, command, id, value, |_| result);
            outcome.changed = (previous != state.snapshot.revision).then(|| state.snapshot.clone());
            Ok(outcome)
        };
        match run() {
            Ok(outcome) => outcome,
            Err(error) => DispatchOutcome {
                result: ApiResult::Failure(error),
                changed: None,
            },
        }
    }
}
fn retry_allowed(state: &State) -> Result<(), ApiError> {
    if state.snapshot.runtime.phase != RuntimePhase::Running {
        return Err(ApiError::new(
            ErrorCode::InvalidState,
            "作業の記録を開始してから、もう一度お試しください。",
        ));
    }
    if !state.snapshot.runtime.consent.activity || !state.snapshot.runtime.consent.history {
        return Err(ApiError::new(
            ErrorCode::ConsentRequired,
            "履歴を使う機能へ同意してから再試行してください。",
        ));
    }
    if state.snapshot.runtime.effective_report_mode == ReportMode::Ai {
        if !state.snapshot.runtime.consent.external_report {
            return Err(ApiError::new(
                ErrorCode::ConsentRequired,
                "AI への送信には現在の設定での同意が必要です。",
            ));
        }
        validate_ai(state)?;
    }
    Ok(())
}
fn fingerprint(state: &State, request: &Value) -> [u64; 2] {
    let text = request.to_string();
    state.fingerprinters.each_ref().map(|builder| {
        let mut hash = builder.build_hasher();
        text.hash(&mut hash);
        hash.finish()
    })
}
