use super::tests::{FakeClock, error_code, snapshot};
use super::*;
use crate::{
    application::persistence::tests::report,
    infrastructure::storage::{FileRepository, MemorySecretStore},
    ports::storage::*,
};
struct NeverRead;
impl ActivitySource for NeverRead {
    fn read(&self, _: &[String]) -> Result<crate::ports::activity::ActivityReading, ActivityError> {
        panic!("must remain stopped")
    }
}
fn service() -> AppService {
    AppService::with_activity_source(
        Arc::new(FakeClock(AtomicU64::new(1_000_000))),
        Id::try_from("storage-runtime".to_string()).unwrap(),
        Arc::new(NeverRead),
    )
    .unwrap()
}
fn settings(request_id: &str, revision: u64) -> Value {
    json!({"requestId":request_id,"expectedSettingsRevision":revision,"values":{"reportMode":"local","provider":null,"excludedApps":["private.exe"],"reducedMotion":true},"keyChange":{"kind":"replace","value":"dummy-storage-key"}})
}
#[test]
fn saved_settings_and_cards_restore_into_stopped_runtime_and_clear_preserves_key() {
    let temp = tempfile::tempdir().unwrap();
    let repo = Arc::new(FileRepository::new(temp.path().into()));
    let secrets = Arc::new(MemorySecretStore::default());
    let first = service();
    first
        .initialize_storage(repo.clone(), secrets.clone())
        .unwrap();
    let request = settings("save", 0);
    let accepted = first.dispatch("main", Command::SettingsUpdate, Some(request.clone()));
    assert!(matches!(accepted.result, ApiResult::Success(_)));
    assert!(accepted.changed.is_some());
    assert_eq!(
        first
            .dispatch("main", Command::SettingsUpdate, Some(request))
            .result,
        accepted.result
    );
    let expected = snapshot(&first).settings;
    assert!(expected.has_api_key);
    assert_eq!(expected.revision.get(), 1);
    first
        .state
        .lock()
        .unwrap()
        .persistence
        .save_report(report(1, 1_000_000), 1_000_000)
        .unwrap();
    drop(first);
    let restored = service();
    restored.initialize_storage(repo.clone(), secrets).unwrap();
    let view = snapshot(&restored);
    assert_eq!(view.settings, expected);
    assert_eq!(view.runtime.phase, RuntimePhase::Stopped);
    assert_eq!(view.runtime.camera, CameraPhase::Off);
    assert_eq!(view.runtime.activity, ActivityPhase::Off);
    assert!(view.runtime.tracking_id.is_none());
    assert!(view.jobs.is_empty());
    assert!(view.session.is_none());
    assert_eq!(view.completion_seq.get(), 0);
    assert!(view.warning.is_none());
    let page = restored.dispatch(
        "main",
        Command::ReportList,
        Some(json!({"cursor":null,"limit":20})),
    );
    let ApiResult::Success(page) = page.result else {
        panic!("page");
    };
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let card = restored.dispatch(
        "main",
        Command::ReportGet,
        Some(json!({"reportId":"report-1"})),
    );
    assert!(matches!(card.result, ApiResult::Success(_)));
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("dummy-storage-key")
    );
    let clear = restored.dispatch(
        "main",
        Command::DataClear,
        Some(json!({"requestId":"clear"})),
    );
    assert!(matches!(clear.result, ApiResult::Success(_)));
    assert_eq!(snapshot(&restored).settings, expected);
    assert!(repo.load_reports().unwrap().unwrap().reports.is_empty());
    assert_eq!(
        error_code(restored.dispatch(
            "main",
            Command::ReportGet,
            Some(json!({"reportId":"report-1"}))
        )),
        ErrorCode::NotFound
    );
}
#[test]
fn settings_are_rejected_while_running_or_stale_and_conflicting_id_does_not_change_them() {
    let service = service();
    service.state.lock().unwrap().snapshot.runtime.phase = RuntimePhase::Running;
    assert_eq!(
        error_code(service.dispatch(
            "main",
            Command::SettingsUpdate,
            Some(settings("running", 0))
        )),
        ErrorCode::InvalidState
    );
    service.state.lock().unwrap().snapshot.runtime.phase = RuntimePhase::Stopped;
    assert_eq!(
        error_code(service.dispatch("main", Command::SettingsUpdate, Some(settings("stale", 10)))),
        ErrorCode::StaleRevision
    );
    assert!(matches!(
        service
            .dispatch("main", Command::SettingsUpdate, Some(settings("valid", 0)))
            .result,
        ApiResult::Success(_)
    ));
    let mut changed = settings("valid", 0);
    changed["keyChange"]["value"] = json!("other-dummy");
    assert_eq!(
        error_code(service.dispatch("main", Command::SettingsUpdate, Some(changed))),
        ErrorCode::Validation
    );
    assert_eq!(snapshot(&service).settings.revision.get(), 1);
}
#[test]
fn corrupt_startup_preserves_original_warns_and_never_starts_sensors() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.json");
    std::fs::write(&path, b"not-json").unwrap();
    let service = service();
    service
        .initialize_storage(
            Arc::new(FileRepository::new(temp.path().into())),
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();
    let view = snapshot(&service);
    assert_eq!(view.runtime.phase, RuntimePhase::Stopped);
    assert_eq!(view.warning.unwrap().code, ErrorCode::StorageFailure);
    assert_eq!(error_code(service.dispatch("main",Command::RuntimeStart,Some(json!({"requestId":"start","profile":"normal","expectedSettingsRevision":0,"reportMode":"local","consent":{"activity":true,"history":true,"externalReport":false}})))),ErrorCode::StorageFailure);
    assert_eq!(std::fs::read(path).unwrap(), b"not-json");
}
#[test]
fn clear_save_failure_still_stops_and_advances_generation_before_reporting_failure() {
    struct BadRepository;
    impl Repository for BadRepository {
        fn load_settings(&self) -> StorageResult<Option<SavedSettings>> {
            Ok(None)
        }
        fn load_reports(&self) -> StorageResult<Option<SavedReports>> {
            Ok(None)
        }
        fn save_settings(&self, _: &SavedSettings) -> StorageResult<()> {
            Err(StorageError::Unavailable)
        }
        fn save_reports(&self, _: &SavedReports) -> StorageResult<()> {
            Err(StorageError::Unavailable)
        }
    }
    let service = service();
    service
        .initialize_storage(
            Arc::new(BadRepository),
            Arc::new(MemorySecretStore::default()),
        )
        .unwrap();
    service.state.lock().unwrap().snapshot.runtime.phase = RuntimePhase::Running;
    let result = service.dispatch(
        "main",
        Command::DataClear,
        Some(json!({"requestId":"clear-fails"})),
    );
    assert!(result.changed.is_some());
    assert_eq!(error_code(result), ErrorCode::StorageFailure);
    let view = snapshot(&service);
    assert_eq!(view.runtime.phase, RuntimePhase::Stopped);
    assert_eq!(view.warning.unwrap().code, ErrorCode::StorageFailure);
    assert_eq!(service.state.lock().unwrap().generation, 1);
}
