use serde_json::{Value, json};
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
    let app = sd_2608_lib::configure(mock_builder())
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
            "runtime_start",
            json!({"requestId":"start","profile":"normal","expectedSettingsRevision":0,"reportMode":"local","consent":{"activity":true,"history":true,"externalReport":false}}),
        ),
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
}
