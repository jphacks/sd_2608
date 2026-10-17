//! 明示実行用の demo 診断。顔は手動入力、PC は実 Windows。画像・タイトルを出力しない。
use sd_2608_lib::{
    application::app_service::{AppService, Command},
    ipc::dto::*,
};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn dispatch(service: &AppService, command: Command, request: Option<Value>) -> Value {
    match service.dispatch("main", command, request).result {
        ApiResult::Success(value) => value,
        ApiResult::Failure(_) => panic!("diagnostic command failed"),
    }
}
fn main() {
    println!("DEMO: manual face=true, real PC input; camera/history/AI are not used.");
    let service = AppService::default();
    let started = dispatch(
        &service,
        Command::RuntimeStart,
        Some(
            json!({"requestId":"probe-start","profile":"demo","expectedSettingsRevision":0,"reportMode":"local","consent":{"activity":true,"history":true,"externalReport":false}}),
        ),
    );
    let tracking = started["runtime"]["trackingId"].clone();
    let mut answered = std::collections::HashSet::new();
    let mut previous = String::new();
    let mut hard_seen = false;
    let mut no_count = 0;
    for sequence in 1..=75 {
        dispatch(
            &service,
            Command::FaceSubmit,
            Some(
                json!({"trackingId":tracking,"sequence":sequence,"observedAt":now(),"source":"manual","kind":"sample","faceDetected":true}),
            ),
        );
        let view: AppSnapshot =
            serde_json::from_value(dispatch(&service, Command::AppGetSnapshot, None)).unwrap();
        let state = format!(
            "presence={:?} sitting_s={} reminder={:?}",
            view.presence.value,
            view.session
                .as_ref()
                .map_or(0, |s| s.elapsed_ms.get() / 1_000),
            view.reminder.as_ref().map(|r| (r.level, r.cause))
        );
        if previous != state {
            println!("{state}");
            previous = state;
        }
        if let Some(reminder) = view.reminder {
            if answered.insert(reminder.id.as_str().to_string()) {
                let hard = reminder.level == ReminderLevel::Hard;
                let reply = dispatch(
                    &service,
                    Command::ReminderRespond,
                    Some(
                        json!({"requestId":format!("probe-answer-{sequence}"),"trackingId":tracking,"sessionId":reminder.session_id,"reminderId":reminder.id,"answer":if hard {"yes"} else {"no"}}),
                    ),
                );
                assert_eq!(reply["reportId"].is_string(), hard);
                println!(
                    "answer={} report_requested={hard}",
                    if hard { "yes" } else { "no" },
                );
                if hard {
                    hard_seen = true;
                    break;
                } else {
                    no_count += 1;
                }
            }
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    dispatch(
        &service,
        Command::RuntimeStop,
        Some(json!({"requestId":"probe-stop","trackingId":tracking})),
    );
    assert!(
        hard_seen && no_count > 0,
        "demo did not reach repeated No and the hard limit; inspect sensor availability"
    );
    println!("PASS: present, reminders, No postponement, hard limit, Yes job accepted, stop");
}
