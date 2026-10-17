use super::{dto::ApiResult, events};
use crate::application::app_service::{AppService, Command};
use serde_json::Value;
use tauri::{Manager, Runtime, State, WebviewWindow};

fn dispatch<R: Runtime>(
    window: WebviewWindow<R>,
    service: State<'_, AppService>,
    command: Command,
    request: Option<Value>,
) -> ApiResult<Value> {
    let outcome = service.dispatch(window.label(), command, request);
    if let Some(snapshot) = outcome.changed {
        events::publish(window.app_handle(), &snapshot);
    }
    outcome.result
}

#[tauri::command]
pub fn app_get_snapshot<R: Runtime>(
    window: WebviewWindow<R>,
    service: State<'_, AppService>,
) -> ApiResult<Value> {
    dispatch(window, service, Command::AppGetSnapshot, None)
}

macro_rules! request_command {
    ($name:ident, $command:ident) => {
        #[tauri::command]
        pub fn $name<R: Runtime>(
            window: WebviewWindow<R>,
            service: State<'_, AppService>,
            request: Option<Value>,
        ) -> ApiResult<Value> {
            dispatch(window, service, Command::$command, request)
        }
    };
}
request_command!(runtime_start, RuntimeStart);
request_command!(runtime_stop, RuntimeStop);
request_command!(face_submit, FaceSubmit);
request_command!(reminder_respond, ReminderRespond);
request_command!(settings_update, SettingsUpdate);
request_command!(report_list, ReportList);
request_command!(report_get, ReportGet);
request_command!(report_retry, ReportRetry);
request_command!(data_clear, DataClear);
