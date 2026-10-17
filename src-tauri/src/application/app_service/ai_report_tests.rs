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
        let mut rig = Rig::with_provider(provider.clone());
        configure(&rig);
        let id = accept(&mut rig);
        {
            let mut state = rig.service.state.lock().unwrap();
            let input = state.reports.inputs.get_mut(id.as_str()).unwrap();
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
