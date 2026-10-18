use super::*;
use super::{
    sitting_tests::Rig,
    tests::{error_code, snapshot},
};
use crate::{
    infrastructure::storage::{MemoryRepository, MemorySecretStore},
    ports::{report_provider::ReportProvider, storage::*},
};
use std::{
    sync::{atomic::AtomicBool, mpsc},
    time::Duration,
};

#[derive(Default)]
struct Provider {
    calls: Mutex<Vec<(ProviderSettings, String, HistorySnapshot)>>,
    fail: AtomicBool,
    began: Mutex<Option<mpsc::Sender<()>>>,
    block: AtomicBool,
}
impl ReportProvider for Provider {
    fn generate(
        &self,
        settings: &ProviderSettings,
        key: &Secret,
        history: &HistorySnapshot,
        current: &(dyn Fn() -> bool + Sync),
    ) -> Result<ReportContent, ApiError> {
        self.calls.lock().unwrap().push((
            settings.clone(),
            String::from_utf8(key.0.clone()).unwrap(),
            history.clone(),
        ));
        if let Some(tx) = self.began.lock().unwrap().take() {
            tx.send(()).unwrap();
        }
        while self.block.load(Ordering::SeqCst) && current() {
            std::thread::sleep(Duration::from_millis(5));
        }
        if !current() {
            return Err(ApiError::new(ErrorCode::Cancelled, "取消"));
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(ApiError::new(
                ErrorCode::NetworkFailure,
                "接続できませんでした。",
            ));
        }
        Ok(ReportContent {
            summary: "記録を確認して立って休みましょう。".into(),
            observed_facts: vec!["エディターを利用していました。".into()],
            next_action: None,
        })
    }
}
fn configure(rig: &Rig) -> Arc<MemoryRepository> {
    let repo = Arc::new(MemoryRepository::default());
    let mut store = Persistence::open(
        repo.clone(),
        Arc::new(MemorySecretStore::default()),
        rig.clock.read().utc_ms,
    );
    store.update(&serde_json::from_value(json!({"requestId":"settings","expectedSettingsRevision":0,"values":{"reportMode":"ai","provider":{"kind":"gemini","endpoint":"https://example.invalid/v1beta","model":"test-model"},"excludedApps":[],"reducedMotion":false},"keyChange":{"kind":"replace","value":"dummy-first-key"}})).unwrap()).unwrap();
    let mut state = rig.service.state.lock().unwrap();
    state.snapshot.settings = store.settings_view();
    state.secret_id = store.secret_id();
    state.snapshot.runtime.effective_report_mode = ReportMode::Ai;
    state.snapshot.runtime.consent.external_report = true;
    drop(state);
    *rig.service.persistence.lock().unwrap() = store;
    repo
}
fn accept(rig: &mut Rig) -> Id {
    rig.stable();
    rig.run(35, true, 0);
    let ApiResult::Success(value) = rig.answer(rig.answer_request("yes-ai", "yes")).result else {
        panic!("yes failed")
    };
    serde_json::from_value(value["reportId"].clone()).unwrap()
}
fn get(rig: &Rig, id: &Id) -> Report {
    let ApiResult::Success(value) = rig
        .service
        .dispatch("main", Command::ReportGet, Some(json!({"reportId":id})))
        .result
    else {
        panic!("missing card")
    };
    serde_json::from_value(value).unwrap()
}
#[derive(Default)]
struct Ocr {
    calls: AtomicU64,
    fail: AtomicBool,
    began: Mutex<Option<mpsc::Sender<()>>>,
    block: AtomicBool,
}
impl crate::ports::ocr::ScreenOcr for Ocr {
    fn collect(
        &self,
        _: &[String],
        current: &(dyn Fn() -> bool + Sync),
    ) -> Result<crate::ports::ocr::OcrBatch, ()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(tx) = self.began.lock().unwrap().take() {
            tx.send(()).unwrap();
        }
        while self.block.load(Ordering::SeqCst) && current() {
            std::thread::sleep(Duration::from_millis(5));
        }
        if self.fail.load(Ordering::SeqCst) || !current() {
            return Err(());
        }
        let used = crate::ports::ocr::OcrWindow {
            key: crate::domain::WindowKey {
                process_id: u32::MAX,
                window_id: "window-1".into(),
            },
            app_name: "editor.exe".into(),
            title: "private-document-title".into(),
            text: "worked on OCR mail@example.test token=private-token".into(),
        };
        let unused = crate::ports::ocr::OcrWindow {
            key: crate::domain::WindowKey {
                process_id: u32::MAX,
                window_id: "other-window".into(),
            },
            app_name: "editor.exe".into(),
            title: "private-document-title".into(),
            text: "unrelated background text".into(),
        };
        Ok(crate::ports::ocr::OcrBatch {
            windows: vec![used, unused],
            unavailable: 0,
        })
    }
}
#[test]
fn ocr_toggle_skips_capture_when_off_and_passes_only_history_matches_when_on() {
    for enabled in [false, true] {
        let provider = Arc::new(Provider::default());
        let ocr = Arc::new(Ocr::default());
        let mut rig = Rig::with_provider_and_ocr(provider.clone(), ocr.clone());
        configure(&rig);
        rig.service
            .state
            .lock()
            .unwrap()
            .snapshot
            .settings
            .ocr_enabled = enabled;
        let id = accept(&mut rig);
        assert!(rig.service.report_worker.step());
        assert_eq!(ocr.calls.load(Ordering::SeqCst), u64::from(enabled));
        let call = provider.calls.lock().unwrap();
        let report = get(&rig, &id);
        if enabled {
            let context = call[0].2.ocr.as_ref().unwrap();
            assert_eq!(context.windows.len(), 1);
            assert_eq!(context.unmatched_windows.get(), 1);
            assert!(context.windows[0].text.contains("worked on OCR"));
            let json = serde_json::to_string(&report.history).unwrap();
            assert!(!json.contains("private-token"));
            assert!(!json.contains("mail@example.test"));
            assert!(!json.contains("unrelated background"));
            assert_eq!(report.history.ocr.as_ref().unwrap(), context);
        } else {
            assert!(call[0].2.ocr.is_none());
            assert!(report.history.ocr.is_none());
        }
    }
}
#[test]
fn ocr_failure_falls_back_to_history_and_does_not_fail_the_report() {
    let provider = Arc::new(Provider::default());
    let ocr = Arc::new(Ocr::default());
    ocr.fail.store(true, Ordering::SeqCst);
    let mut rig = Rig::with_provider_and_ocr(provider.clone(), ocr);
    configure(&rig);
    rig.service
        .state
        .lock()
        .unwrap()
        .snapshot
        .settings
        .ocr_enabled = true;
    let id = accept(&mut rig);
    assert!(rig.service.report_worker.step());
    let report = get(&rig, &id);
    assert_eq!(report.status, ReportStatus::Ready);
    assert_eq!(report.history.ocr.unwrap().unavailable_windows.get(), 1);
    assert_eq!(provider.calls.lock().unwrap().len(), 1);
}
#[test]
fn retry_reuses_frozen_ocr_or_omits_it_when_turned_off() {
    for (initial, enabled) in [(true, true), (true, false), (false, true)] {
        let provider = Arc::new(Provider::default());
        provider.fail.store(true, Ordering::SeqCst);
        let ocr = Arc::new(Ocr::default());
        let mut rig = Rig::with_provider_and_ocr(provider.clone(), ocr.clone());
        configure(&rig);
        rig.service
            .state
            .lock()
            .unwrap()
            .snapshot
            .settings
            .ocr_enabled = initial;
        let id = accept(&mut rig);
        assert!(rig.service.report_worker.step());
        let failed = get(&rig, &id);
        assert_eq!(failed.history.ocr.is_some(), initial);
        provider.fail.store(false, Ordering::SeqCst);
        rig.service
            .state
            .lock()
            .unwrap()
            .snapshot
            .settings
            .ocr_enabled = enabled;
        let retried = rig.service.dispatch(
            "main",
            Command::ReportRetry,
            Some(json!({
                "requestId":"retry-ocr", "reportId":id, "expectedAttempt":1
            })),
        );
        assert!(matches!(retried.result, ApiResult::Success(_)));
        for _ in 0..200 {
            if snapshot(&rig.service).jobs[0].status == JobStatus::Ready {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let ready = get(&rig, &id);
        assert_eq!(ready.status, ReportStatus::Ready, "{:?}", ready.error);
        assert_eq!(ocr.calls.load(Ordering::SeqCst), 1);
        let calls = provider.calls.lock().unwrap();
        if enabled && initial {
            assert_eq!(calls[1].2.ocr, failed.history.ocr);
            assert_eq!(ready.history.ocr, failed.history.ocr);
        } else if enabled {
            assert!(calls[1].2.ocr.is_some());
            assert_eq!(ready.history.ocr, calls[1].2.ocr);
        } else {
            assert!(calls[1].2.ocr.is_none());
            assert_eq!(ready.history.ocr, failed.history.ocr);
        }
    }
}
#[test]
fn stop_cancels_ocr_without_waiting_and_never_calls_the_ai_after_stop() {
    let provider = Arc::new(Provider::default());
    let ocr = Arc::new(Ocr::default());
    let (tx, rx) = mpsc::channel();
    *ocr.began.lock().unwrap() = Some(tx);
    ocr.block.store(true, Ordering::SeqCst);
    let mut rig = Rig::with_provider_and_ocr(provider.clone(), ocr);
    configure(&rig);
    rig.service
        .state
        .lock()
        .unwrap()
        .snapshot
        .settings
        .ocr_enabled = true;
    accept(&mut rig);
    let service = Arc::new(rig.service);
    let worker = service.clone();
    let thread = std::thread::spawn(move || worker.report_worker.step());
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    service.stop_for_lifecycle().unwrap();
    assert!(thread.join().unwrap());
    assert!(provider.calls.lock().unwrap().is_empty());
}
#[test]
fn ai_failure_is_persisted_and_explicit_retry_keeps_history_with_current_key_and_settings() {
    let provider = Arc::new(Provider::default());
    provider.fail.store(true, Ordering::SeqCst);
    let mut rig = Rig::with_provider(provider.clone());
    let repo = configure(&rig);
    let id = accept(&mut rig);
    assert!(rig.service.report_worker.step());
    let failed = get(&rig, &id);
    assert_eq!(failed.status, ReportStatus::Failed);
    assert_eq!(
        failed.error.as_ref().unwrap().code,
        ErrorCode::NetworkFailure
    );
    assert_eq!(repo.load_reports().unwrap().unwrap().reports[0], failed);
    assert_eq!(snapshot(&rig.service).jobs[0].status, JobStatus::Failed);
    assert_eq!(provider.calls.lock().unwrap().len(), 1);
    assert!(!rig.service.report_worker.step());
    // 別の監視で同意し直した現在の設定を使う。元カードの履歴は不変。
    rig.service.stop_for_lifecycle().unwrap();
    let result=rig.service.dispatch("main",Command::SettingsUpdate,Some(json!({"requestId":"new-target","expectedSettingsRevision":1,"values":{"reportMode":"ai","provider":{"kind":"openAiCompatible","endpoint":"https://other.invalid/v1/chat/completions","model":"other-model"},"excludedApps":[],"reducedMotion":false},"keyChange":{"kind":"replace","value":"dummy-second-key"}})));
    assert!(matches!(result.result, ApiResult::Success(_)));
    let start = |id: &str, revision: u64, consent: bool| json!({"requestId":id,"profile":"demo","expectedSettingsRevision":revision,"reportMode":"ai","consent":{"activity":true,"history":true,"externalReport":consent}});
    assert_eq!(
        error_code(rig.service.dispatch(
            "main",
            Command::RuntimeStart,
            Some(start("stale", 1, true))
        )),
        ErrorCode::StaleRevision
    );
    assert_eq!(
        error_code(rig.service.dispatch(
            "main",
            Command::RuntimeStart,
            Some(start("unconsented", 2, false))
        )),
        ErrorCode::ConsentRequired
    );
    provider.fail.store(false, Ordering::SeqCst);
    assert!(matches!(
        rig.service
            .dispatch(
                "main",
                Command::RuntimeStart,
                Some(start("consented", 2, true))
            )
            .result,
        ApiResult::Success(_)
    ));
    let retry = json!({"requestId":"retry-ai","reportId":id,"expectedAttempt":1});
    let first = rig
        .service
        .dispatch("main", Command::ReportRetry, Some(retry.clone()))
        .result;
    assert!(matches!(first, ApiResult::Success(_)));
    assert_eq!(
        rig.service
            .dispatch("main", Command::ReportRetry, Some(retry))
            .result,
        first
    );
    for _ in 0..200 {
        if snapshot(&rig.service).jobs[0].status == JobStatus::Ready {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready = get(&rig, &id);
    assert_eq!(ready.status, ReportStatus::Ready);
    assert_eq!(ready.attempt.get(), 2);
    assert_eq!(ready.created_at, failed.created_at);
    assert_eq!(ready.history, failed.history);
    let calls = provider.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].1, "dummy-first-key");
    assert_eq!(calls[1].1, "dummy-second-key");
    assert_eq!(calls[1].0.model, "other-model");
    assert_eq!(calls[0].2, calls[1].2);
    assert!(!serde_json::to_string(&ready).unwrap().contains("dummy-"));
}
#[test]
fn frozen_job_uses_its_original_provider_key_and_consent() {
    let provider = Arc::new(Provider::default());
    let mut rig = Rig::with_provider(provider.clone());
    configure(&rig);
    let id = accept(&mut rig);
    {
        let mut state = rig.service.state.lock().unwrap();
        state.snapshot.settings.provider.as_mut().unwrap().model = "not-this-model".into();
        state.secret_id = None;
        state.snapshot.runtime.consent.external_report = false;
    }
    assert!(rig.service.report_worker.step());
    assert_eq!(get(&rig, &id).status, ReportStatus::Ready);
    let calls = provider.calls.lock().unwrap();
    assert_eq!(calls[0].0.model, "test-model");
    assert_eq!(calls[0].1, "dummy-first-key");
}
#[test]
fn local_and_empty_history_skip_provider_and_secret_access() {
    for empty in [true, false] {
        let provider = Arc::new(Provider::default());
        let ocr = Arc::new(Ocr::default());
        let mut rig = Rig::with_provider_and_ocr(provider.clone(), ocr.clone());
        configure(&rig);
        let id = accept(&mut rig);
        {
            let mut state = rig.service.state.lock().unwrap();
            let input = state.reports.inputs.get_mut(id.as_str()).unwrap();
            input.settings.ocr_enabled = true;
            if empty {
                input.history.segments.clear();
            } else {
                input.mode = ReportMode::Local;
            }
            input.secret_id = None;
        }
        assert!(rig.service.report_worker.step());
        assert_eq!(get(&rig, &id).status, ReportStatus::Local);
        assert!(provider.calls.lock().unwrap().is_empty());
        assert_eq!(ocr.calls.load(Ordering::SeqCst), 0);
    }
}
#[test]
fn stop_and_clear_cancel_inflight_generation_without_waiting_or_reviving_cards() {
    for clear in [false, true] {
        let provider = Arc::new(Provider::default());
        provider.block.store(true, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        *provider.began.lock().unwrap() = Some(tx);
        let mut rig = Rig::with_provider(provider.clone());
        let repo = configure(&rig);
        accept(&mut rig);
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| rig.service.report_worker.step());
            rx.recv_timeout(Duration::from_secs(2)).unwrap();
            // 生成中にも snapshot とカード一覧を読める。別ジョブは並列生成されない。
            assert_eq!(snapshot(&rig.service).jobs[0].status, JobStatus::Running);
            assert!(!rig.service.report_worker.step());
            assert!(matches!(
                rig.service
                    .dispatch(
                        "main",
                        Command::ReportList,
                        Some(json!({"cursor":null,"limit":20}))
                    )
                    .result,
                ApiResult::Success(_)
            ));
            let began = std::time::Instant::now();
            if clear {
                assert!(matches!(
                    rig.service
                        .dispatch(
                            "main",
                            Command::DataClear,
                            Some(json!({"requestId":"clear-ai"}))
                        )
                        .result,
                    ApiResult::Success(_)
                ));
            } else {
                rig.service.stop_for_lifecycle().unwrap();
            }
            assert!(began.elapsed() < Duration::from_millis(250));
            worker.join().unwrap();
        });
        assert_eq!(snapshot(&rig.service).completion_seq.get(), 0);
        assert!(
            repo.load_reports()
                .unwrap()
                .is_none_or(|saved| saved.reports.is_empty())
        );
        assert_eq!(provider.calls.lock().unwrap().len(), 1);
    }
}
