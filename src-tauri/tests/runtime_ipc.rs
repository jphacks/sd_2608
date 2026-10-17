use sd_2608_lib::{
    application::app_service::AppService,
    ipc::dto::Id,
    ports::{
        activity::{ActivityError, ActivityReading, ActivitySource, Foreground},
        clock::SystemClock,
    },
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tauri::{
    WebviewWindow,
    ipc::{CallbackFn, InvokeBody},
    test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets},
};

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, body: Value) -> Value {
    get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .unwrap()
    .deserialize()
    .unwrap()
}

#[test]
fn registered_ipc_commands_return_the_contract_and_restrict_other_windows() {
    struct Source(Arc<AtomicUsize>);
    impl ActivitySource for Source {
        fn read(&self, _: &[String]) -> Result<ActivityReading, ActivityError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(ActivityReading {
                idle_ms: Some(60_000),
                foreground: Foreground::Unavailable,
            })
        }
    }
    let reads = Arc::new(AtomicUsize::new(0));
    let service = AppService::with_activity_source(
        Arc::new(SystemClock::default()),
        Id::try_from("ipc-runtime".to_string()).unwrap(),
        Arc::new(Source(reads.clone())),
    )
    .unwrap();
    let app = sd_2608_lib::configure_with_service(mock_builder(), service)
        .build(mock_context(noop_assets()))
        .unwrap();
    let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let initial = invoke(&main, "app_get_snapshot", json!({}));
    assert_eq!(initial["ok"], true);
    assert_eq!(initial["data"]["runtime"]["phase"], "stopped");
    let _: sd_2608_lib::ipc::dto::ApiResult<sd_2608_lib::ipc::dto::AppSnapshot> =
        serde_json::from_value(initial).unwrap();
    assert_eq!(
        invoke(&main, "report_list", json!({}))["error"]["code"],
        "validation"
    );
    assert_eq!(
        invoke(
            &main,
            "report_list",
            json!({"request":{"cursor":null,"limit":20}})
        ),
        json!({"ok":true,"data":{"items":[],"nextCursor":null}})
    );
    assert_eq!(
        invoke(
            &main,
            "data_clear",
            json!({"request":{"requestId":"ipc-clear"}})
        )["data"]["revision"],
        1
    );
    let requests = [
        (
            "runtime_stop",
            json!({"requestId":"stop","trackingId":"missing"}),
        ),
        (
            "face_submit",
            json!({"trackingId":"missing","sequence":1,"observedAt":0,"source":"camera","kind":"sample","faceDetected":true}),
        ),
        (
            "reminder_respond",
            json!({"requestId":"answer","trackingId":"missing","sessionId":"missing","reminderId":"missing","answer":"yes"}),
        ),
        (
            "settings_update",
            json!({"requestId":"settings","expectedSettingsRevision":0,"values":{"reportMode":"local","provider":null,"excludedApps":[],"reducedMotion":false},"keyChange":{"kind":"keep"}}),
        ),
        ("report_get", json!({"reportId":"missing"})),
        (
            "report_retry",
            json!({"requestId":"retry","reportId":"missing","expectedAttempt":1}),
        ),
    ];
    for (command, request) in requests {
        assert_eq!(
            invoke(&main, command, json!({"request":request}))["ok"],
            false,
            "{command}"
        );
    }
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default())
        .build()
        .unwrap();
    assert_eq!(
        invoke(&other, "app_get_snapshot", json!({}))["error"]["code"],
        "permissionDenied"
    );
    let start = json!({"request":{"requestId":"start","profile":"normal","expectedSettingsRevision":0,"reportMode":"local","consent":{"activity":true,"history":true,"externalReport":false}}});
    assert_eq!(
        invoke(&other, "runtime_start", start.clone())["error"]["code"],
        "permissionDenied"
    );
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    let started = invoke(&main, "runtime_start", start);
    assert_eq!(started["ok"], true);
    assert_eq!(started["data"]["runtime"]["phase"], "running");
    assert_eq!(started["data"]["runtime"]["camera"], "off");
    assert_eq!(started["data"]["presence"]["value"], "unknown");
    let stopped = invoke(
        &main,
        "runtime_stop",
        json!({"request":{"requestId":"stop-current","trackingId":started["data"]["runtime"]["trackingId"]}}),
    );
    assert_eq!(stopped["ok"], true);
    assert_eq!(stopped["data"]["runtime"]["phase"], "stopped");
    assert_eq!(stopped["data"]["runtime"]["activity"], "off");
}
