use super::*;
use crate::{
    application::report_coordinator::{Input, local_report},
    domain as d,
};
use std::{
    sync::{Condvar, Weak, atomic::AtomicBool},
    thread::JoinHandle,
    time::Duration,
};

#[derive(Default)]
pub(super) struct Wake {
    signal: Mutex<bool>,
    wake: Condvar,
    shutdown: AtomicBool,
}
impl Wake {
    pub(super) fn notify(&self) {
        if let Ok(mut signal) = self.signal.lock() {
            *signal = true;
            self.wake.notify_all();
        }
    }
}
pub(super) struct ReportWorker {
    state: Weak<Mutex<State>>,
    store: Arc<Mutex<Persistence>>,
    clock: Arc<dyn Clock>,
    publisher: Arc<Mutex<Option<SnapshotPublisher>>>,
    generation: Arc<AtomicU64>,
    wake: Arc<Wake>,
    provider: Arc<dyn crate::ports::report_provider::ReportProvider>,
    ocr: Arc<dyn crate::ports::ocr::ScreenOcr>,
    thread: Mutex<Option<JoinHandle<()>>>,
}
impl ReportWorker {
    pub(super) fn new(
        state: Weak<Mutex<State>>,
        store: Arc<Mutex<Persistence>>,
        clock: Arc<dyn Clock>,
        publisher: Arc<Mutex<Option<SnapshotPublisher>>>,
        generation: Arc<AtomicU64>,
        provider: Arc<dyn crate::ports::report_provider::ReportProvider>,
        ocr: Arc<dyn crate::ports::ocr::ScreenOcr>,
    ) -> Self {
        let wake = state.upgrade().unwrap().lock().unwrap().report_wake.clone();
        Self {
            state,
            store,
            clock,
            publisher,
            generation,
            wake,
            provider,
            ocr,
            thread: Mutex::new(None),
        }
    }
    pub(super) fn start(&self) -> Result<(), ApiError> {
        let mut thread = self.thread.lock().map_err(|_| internal())?;
        if thread.is_some() {
            self.wake.notify();
            return Ok(());
        }
        let (state, store, clock, publisher, generation, wake) = (
            self.state.clone(),
            self.store.clone(),
            self.clock.clone(),
            self.publisher.clone(),
            self.generation.clone(),
            self.wake.clone(),
        );
        let provider = self.provider.clone();
        let ocr = self.ocr.clone();
        *thread = Some(
            std::thread::Builder::new()
                .name("report-worker".into())
                .spawn(move || {
                    while !wake.shutdown.load(Ordering::SeqCst) {
                        if process_next(
                            &state,
                            &store,
                            &clock,
                            &publisher,
                            &generation,
                            &wake,
                            provider.as_ref(),
                            ocr.as_ref(),
                        ) {
                            continue;
                        }
                        let Ok(signal) = wake.signal.lock() else {
                            return;
                        };
                        let Ok((mut signal, _)) = wake.wake.wait_timeout_while(
                            signal,
                            Duration::from_millis(250),
                            |signal| !*signal && !wake.shutdown.load(Ordering::SeqCst),
                        ) else {
                            return;
                        };
                        *signal = false;
                    }
                })
                .map_err(|_| internal())?,
        );
        Ok(())
    }
    #[cfg(test)]
    pub(super) fn step(&self) -> bool {
        process_next(
            &self.state,
            &self.store,
            &self.clock,
            &self.publisher,
            &self.generation,
            &self.wake,
            self.provider.as_ref(),
            self.ocr.as_ref(),
        )
    }
}
impl Drop for ReportWorker {
    fn drop(&mut self) {
        self.wake.shutdown.store(true, Ordering::SeqCst);
        self.wake.notify();
    }
}
pub(super) fn project(state: &mut State) {
    state.snapshot.jobs = state.reports.views();
    state.snapshot.completion_seq =
        SafeInt::try_from(state.reports.queue.completion_seq.min(MAX_SAFE_INTEGER)).unwrap();
    if let Some(session) = &mut state.snapshot.session {
        session.report_job_id = state
            .reports
            .queue
            .for_session(session.id.as_str())
            .and_then(|job| Id::try_from(job.id.clone()).ok());
    }
}
pub(super) fn bump(state: &mut State, now: u64) -> Result<(), ApiError> {
    state.snapshot.revision = SafeInt::try_from(
        state
            .snapshot
            .revision
            .get()
            .checked_add(1)
            .ok_or_else(internal)?,
    )
    .map_err(|_| internal())?;
    state.snapshot.emitted_at = SafeInt::try_from(now).map_err(|_| internal())?;
    Ok(())
}
pub(super) fn register(
    state: &mut State,
    session: &d::Session,
    trigger: d::ReportTrigger,
    at: d::Time,
) -> Result<(), ApiError> {
    if !state.snapshot.runtime.consent.history || !state.snapshot.runtime.consent.activity {
        return Err(ApiError::new(
            ErrorCode::ConsentRequired,
            "履歴の利用には同意が必要です。",
        ));
    }
    let history = history::requested(state, session, at)?;
    let id = sitting::domain_id(state, "report", session.id)?;
    let input = Input {
        history,
        settings: state.snapshot.settings.clone(),
        consent: state.snapshot.runtime.consent.clone(),
        mode: state.snapshot.runtime.effective_report_mode,
        secret_id: state.secret_id.clone(),
        created_at: None,
    };
    let delay = if trigger == d::ReportTrigger::Away {
        sitting::timings(state.snapshot.runtime.profile).report_delay_ms
    } else {
        0
    };
    state
        .reports
        .register(id, input, trigger, at, delay, state.generation);
    let current = state
        .snapshot
        .session
        .as_ref()
        .map(|session| session.id.as_str());
    state.reports.compact(current);
    project(state);
    state.report_wake.notify();
    Ok(())
}
fn publish(publisher: &Arc<Mutex<Option<SnapshotPublisher>>>, snapshot: &AppSnapshot) {
    let callback = publisher
        .lock()
        .ok()
        .and_then(|publisher| publisher.clone());
    if let Some(callback) = callback {
        callback(snapshot);
    }
}
fn process_next(
    weak: &Weak<Mutex<State>>,
    store: &Arc<Mutex<Persistence>>,
    clock: &Arc<dyn Clock>,
    publisher: &Arc<Mutex<Option<SnapshotPublisher>>>,
    generation: &Arc<AtomicU64>,
    wake: &Wake,
    provider: &dyn crate::ports::report_provider::ReportProvider,
    ocr: &dyn crate::ports::ocr::ScreenOcr,
) -> bool {
    let Some(state) = weak.upgrade() else {
        return false;
    };
    let began = clock.read();
    let (job, mut input, started, ocr_salt) = {
        let Ok(mut state) = state.lock() else {
            return false;
        };
        if began.utc_ms > MAX_SAFE_INTEGER || state.snapshot.revision.get() >= MAX_SAFE_INTEGER {
            return false;
        }
        let Some(job) = state.reports.queue.take(d::Time {
            utc_ms: began.utc_ms,
            elapsed_ms: began.elapsed_ms,
        }) else {
            return false;
        };
        let Some(input) = state.reports.inputs.get(&job.id).cloned() else {
            return false;
        };
        project(&mut state);
        let _ = bump(&mut state, began.utc_ms);
        (
            job,
            input,
            state.snapshot.clone(),
            state.fingerprinters[1].clone(),
        )
    };
    publish(publisher, &started);
    let current = || {
        generation.load(Ordering::SeqCst) == job.generation && !wake.shutdown.load(Ordering::SeqCst)
    };
    let generated = if input.mode == ReportMode::Ai && !input.history.segments.is_empty() {
        (|| {
            if !input.consent.external_report || !input.consent.history || !input.consent.activity {
                return Err(ApiError::new(
                    ErrorCode::ConsentRequired,
                    "AI への送信には同意が必要です。",
                ));
            }
            let settings = input.settings.provider.as_ref().ok_or_else(|| {
                ApiError::new(
                    ErrorCode::ProviderNotConfigured,
                    "AI の接続設定が必要です。",
                )
            })?;
            let secret_id = input.secret_id.as_ref().ok_or_else(|| {
                ApiError::new(
                    ErrorCode::ProviderNotConfigured,
                    "API キーを登録してください。",
                )
            })?;
            // 秘密の復号だけを保存ロック内で行い、ネットワーク中はどのロックも保持しない。
            let key = store
                .lock()
                .map_err(|_| internal())?
                .read_secret(secret_id)?;
            if input.settings.ocr_enabled && input.history.ocr.is_none() && current() {
                let batch = ocr.collect(&input.settings.excluded_apps, &current);
                if !current() {
                    return Err(ApiError::new(
                        ErrorCode::Cancelled,
                        "レポート作成を取り消しました。",
                    ));
                }
                input.history.ocr = Some(crate::application::ocr_context::context(
                    batch,
                    &input.history,
                    clock.read().utc_ms,
                    &ocr_salt,
                ));
                // 再試行でも同じ履歴と OCR を使用する。OS 取得中に状態ロックを持たない。
                if let Ok(mut state) = state.lock() {
                    if state.generation == job.generation {
                        if let Some(frozen) = state.reports.inputs.get_mut(&job.id) {
                            frozen.history.ocr = input.history.ocr.clone();
                        }
                    }
                }
            }
            // オフにして再試行しても保存済みカードの固定履歴は変えない。
            let mut provider_history = input.history.clone();
            if !input.settings.ocr_enabled {
                provider_history.ocr = None;
            }
            provider
                .generate(settings, &key, &provider_history, &current)
                .map(Some)
        })()
    } else {
        Ok(None)
    };
    if !current() {
        return true;
    }
    let completed = clock.read();
    let mut report = local_report(&job, &input, completed.utc_ms);
    let generation_error = match generated {
        Ok(Some(content)) => {
            report.status = ReportStatus::Ready;
            report.content = Some(content);
            None
        }
        Ok(None) => None,
        Err(mut error) => {
            error.retryable = true;
            report.status = ReportStatus::Failed;
            report.error = Some(error.clone());
            Some(error)
        }
    };
    let (result, warning) = {
        let Ok(mut store) = store.lock() else {
            return false;
        };
        let result = store.save_report_guarded(report.clone(), completed.utc_ms, current);
        if let Err(error) = &result {
            if current() && error.code != ErrorCode::Cancelled {
                report.status = ReportStatus::Failed;
                report.content = None;
                let mut error = error.clone();
                error.retryable = true;
                report.error = Some(error);
                store.remember_failure(report.clone());
            }
        }
        (
            result.and_then(|_| generation_error.map_or(Ok(()), Err)),
            store.warning(),
        )
    };
    if !current() {
        // 古い完了は配らない。復元自体の保存障害は現在のアプリにも知らせる。
        if let Some(warning) = warning {
            if let Ok(mut state) = state.lock() {
                state.persistence_warning = Some(warning.clone());
                state.snapshot.warning = Some(warning);
                if bump(&mut state, clock.read().utc_ms).is_ok() {
                    let snapshot = state.snapshot.clone();
                    drop(state);
                    publish(publisher, &snapshot);
                }
            }
        }
        return true;
    }
    let finished = {
        let Ok(mut state) = state.lock() else {
            return false;
        };
        if !current() || state.generation != job.generation {
            return true;
        }
        if !state
            .reports
            .queue
            .finish(&job.id, job.generation, job.attempt, result.is_err())
        {
            return true;
        }
        if let Some(input) = state.reports.inputs.get_mut(&job.id) {
            input.created_at = Some(report.created_at);
        }
        state.persistence_warning = warning;
        state.report_error = result.err();
        project(&mut state);
        if state.snapshot.runtime.phase == RuntimePhase::Running {
            sitting::project(&mut state);
        }
        let _ = bump(&mut state, clock.read().utc_ms);
        state.snapshot.clone()
    };
    publish(publisher, &finished);
    true
}
