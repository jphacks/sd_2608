//! cargo run --locked --example storage_probe
//! 専用一時ディレクトリ・ダミーデータだけで、プロセス終了後の復元を検証する。
use sd_2608_lib::{
    application::{
        app_service::{AppService, Command},
        persistence::Persistence,
    },
    infrastructure::storage::{FileRepository, secrets::DpapiSecretStore},
    ipc::dto::*,
    ports::{
        activity::{ActivityError, ActivityReading, ActivitySource},
        clock::{Clock, SystemClock},
    },
};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};
struct NoSensor;
impl ActivitySource for NoSensor {
    fn read(&self, _: &[String]) -> Result<ActivityReading, ActivityError> {
        panic!("storage probe must not start sensors")
    }
}
fn call(service: &AppService, command: Command, request: Option<Value>) -> Value {
    match service.dispatch("main", command, request).result {
        ApiResult::Success(value) => value,
        ApiResult::Failure(error) => panic!("storage probe: {:?}", error.code),
    }
}
fn phase(root: &Path, mode: &str) {
    assert!(
        root.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("sd2608-storage-probe-")
    );
    assert_eq!(
        std::fs::read(root.join("probe.marker")).unwrap(),
        b"dummy-data-only"
    );
    let clock = Arc::new(SystemClock::default());
    let now = clock.read().utc_ms;
    let repo = Arc::new(FileRepository::new(root.into()));
    let secrets = Arc::new(DpapiSecretStore::new(root.into()));
    if mode == "write" {
        let card:Report = serde_json::from_value(json!({"id":"probe-report","sessionId":"probe-session","trigger":"yes","createdAt":now,"updatedAt":now,"attempt":1,"status":"local","history":{"id":"probe-history","sessionId":"probe-session","capturedAt":now,"rangeStart":now-1000,"rangeEnd":now,"segments":[{"id":"probe-segment","sessionId":"probe-session","startedAt":now-1000,"endedAt":now,"appName":"dummy-editor.exe","maskedTitle":"架空の作業 [URL]"}]},"content":null,"error":null})).unwrap();
        Persistence::open(repo.clone(), secrets.clone(), now)
            .save_report(card, now)
            .unwrap();
    }
    let service = AppService::with_activity_source(
        clock,
        Id::try_from("storage-probe".to_string()).unwrap(),
        Arc::new(NoSensor),
    )
    .unwrap();
    service.initialize_storage(repo, secrets).unwrap();
    if mode == "write" {
        call(
            &service,
            Command::SettingsUpdate,
            Some(
                json!({"requestId":"probe-settings","expectedSettingsRevision":0,"values":{"reportMode":"local","provider":null,"excludedApps":["dummy-private.exe"],"reducedMotion":true},"keyChange":{"kind":"replace","value":"dummy-probe-api-key-only"}}),
            ),
        );
    }
    let view = call(&service, Command::AppGetSnapshot, None);
    assert_eq!(view["runtime"]["phase"], "stopped");
    assert_eq!(view["runtime"]["camera"], "off");
    assert_eq!(view["runtime"]["activity"], "off");
    assert_eq!(view["runtime"]["consent"]["history"], false);
    assert!(view["runtime"]["trackingId"].is_null());
    assert!(view["session"].is_null());
    assert!(view["reminder"].is_null());
    assert!(view["jobs"].as_array().unwrap().is_empty());
    assert_eq!(view["completionSeq"], 0);
    assert_eq!(view["settings"]["revision"], 1);
    assert_eq!(view["settings"]["hasApiKey"], true);
    assert_eq!(view["settings"]["reducedMotion"], true);
    assert!(view["warning"].is_null());
    assert!(service.latest_activity().is_none());
    assert!(service.latest_face().is_none());
    assert!(!view.to_string().contains("dummy-probe-api-key-only"));
    let page = call(
        &service,
        Command::ReportList,
        Some(json!({"cursor":null,"limit":20})),
    );
    assert_eq!(
        page["items"].as_array().unwrap().len(),
        if mode == "after-clear" { 0 } else { 1 }
    );
    if mode == "read" {
        let report = call(
            &service,
            Command::ReportGet,
            Some(json!({"reportId":"probe-report"})),
        );
        assert_eq!(report["status"], "local");
    }
    if mode == "clear" {
        call(
            &service,
            Command::DataClear,
            Some(json!({"requestId":"probe-clear"})),
        );
    }
    println!("{mode}: ok (sensors off, settings/key retained)");
}
fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 3 && arguments[0] == "--child" {
        phase(Path::new(&arguments[2]), arguments[1].to_str().unwrap());
        return;
    }
    assert!(arguments.is_empty(), "run without arguments");
    let temp = tempfile::Builder::new()
        .prefix("sd2608-storage-probe-")
        .tempdir()
        .unwrap();
    std::fs::write(temp.path().join("probe.marker"), b"dummy-data-only").unwrap();
    for mode in ["write", "read", "clear", "after-clear"] {
        assert!(
            std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--child")
                .arg(mode)
                .arg(temp.path())
                .status()
                .unwrap()
                .success(),
            "probe phase failed"
        );
    }
    println!("separate-process restore/clear: ok (temporary dummy data only)");
}
