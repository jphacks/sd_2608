//! 実時計・実ワーカー・一時 JSON 保存を、架空の PC/手動顔入力で検証する（最大85秒）。
use sd_2608_lib::{
    application::app_service::{AppService, Command},
    infrastructure::storage::{FileRepository, secrets::DpapiSecretStore},
    ipc::dto::*,
    ports::{
        activity::*,
        clock::{Clock, SystemClock},
    },
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
struct DummySource(Arc<AtomicU64>);
impl ActivitySource for DummySource {
    fn read(&self, _: &[String]) -> Result<ActivityReading, ActivityError> {
        Ok(ActivityReading {
            idle_ms: Some(self.0.load(Ordering::SeqCst)),
            foreground: Foreground::External(WindowInfo {
                window_id: "dummy-window".into(),
                process_id: std::process::id() + 1,
                app_name: "dummy-editor.exe".into(),
                window_title: "架空の作業 https://example.invalid/private".into(),
            }),
        })
    }
}
fn call(service: &AppService, command: Command, request: Option<Value>) -> Value {
    match service.dispatch("main", command, request).result {
        ApiResult::Success(value) => value,
        ApiResult::Failure(error) => panic!("report probe: {:?}", error.code),
    }
}
fn start(service: &AppService, id: &str) -> String {
    call(service,Command::RuntimeStart,Some(json!({"requestId":id,"profile":"demo","expectedSettingsRevision":0,"reportMode":"local","consent":{"activity":true,"history":true,"externalReport":false}})))["runtime"]["trackingId"].as_str().unwrap().into()
}
fn check_card(service: &AppService, id: &str) {
    let report = call(service, Command::ReportGet, Some(json!({"reportId":id})));
    assert_eq!(report["status"], "local");
    assert!(!report["history"]["segments"].as_array().unwrap().is_empty());
    assert!(
        !report
            .to_string()
            .contains("https://example.invalid/private")
    );
}
fn main() {
    let temp = tempfile::Builder::new()
        .prefix("sd2608-report-probe-")
        .tempdir()
        .unwrap();
    let idle = Arc::new(AtomicU64::new(0));
    let clock = Arc::new(SystemClock::default());
    let service = AppService::with_activity_source(
        clock.clone(),
        Id::try_from("report-probe".to_string()).unwrap(),
        Arc::new(DummySource(idle.clone())),
    )
    .unwrap();
    service
        .initialize_storage(
            Arc::new(FileRepository::new(temp.path().into())),
            Arc::new(DpapiSecretStore::new(temp.path().into())),
        )
        .unwrap();
    let mut tracking = start(&service, "start-yes");
    let mut sequence = 0u64;
    let mut phase = 0;
    let mut yes_id = String::new();
    let mut away_id = String::new();
    let mut due = 0u64;
    for _ in 0..85 {
        sequence += 1;
        call(
            &service,
            Command::FaceSubmit,
            Some(
                json!({"trackingId":tracking,"sequence":sequence,"observedAt":clock.read().utc_ms,"source":"manual","kind":"sample","faceDetected":phase<3}),
            ),
        );
        let view = call(&service, Command::AppGetSnapshot, None);
        if phase == 0 && !view["reminder"].is_null() {
            let reply = call(
                &service,
                Command::ReminderRespond,
                Some(
                    json!({"requestId":"yes","trackingId":tracking,"sessionId":view["reminder"]["sessionId"],"reminderId":view["reminder"]["id"],"answer":"yes"}),
                ),
            );
            yes_id = reply["reportId"].as_str().unwrap().into();
            phase = 1;
            println!("yes: accepted");
        } else if phase == 1
            && view["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|job| job["id"] == yes_id && job["status"] == "ready")
        {
            check_card(&service, &yes_id);
            println!("yes: local card persisted, completionSeq=1");
            call(
                &service,
                Command::RuntimeStop,
                Some(json!({"requestId":"stop-yes","trackingId":tracking})),
            );
            tracking = start(&service, "start-away");
            sequence = 0;
            phase = 2;
        } else if phase == 2 && view["presence"]["value"] == "present" {
            idle.store(60_000, Ordering::SeqCst);
            phase = 3;
        } else if phase == 3 && view["presence"]["value"] == "away" {
            let job = view["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|job| job["trigger"] == "away")
                .unwrap();
            assert_eq!(job["status"], "scheduled");
            due = job["dueAt"].as_u64().unwrap();
            assert_eq!(due - job["requestedAt"].as_u64().unwrap(), 5000);
            away_id = job["id"].as_str().unwrap().into();
            phase = 4;
            println!("away: confirmed, demo reservation +5s");
        } else if phase == 4
            && view["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|job| job["id"] == away_id && job["status"] == "ready")
        {
            assert!(clock.read().utc_ms >= due);
            assert_eq!(view["presence"]["value"], "away");
            assert_eq!(view["completionSeq"], 2);
            check_card(&service, &away_id);
            println!("away: local card persisted while away, completionSeq=2");
            call(
                &service,
                Command::DataClear,
                Some(json!({"requestId":"clear"})),
            );
            let page = call(
                &service,
                Command::ReportList,
                Some(json!({"cursor":null,"limit":20})),
            );
            assert!(page["items"].as_array().unwrap().is_empty());
            println!(
                "PASS: real scheduler, both paths, masked history, temporary persistence, clear (no real camera/PC data)"
            );
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    panic!("report probe timeout");
}
