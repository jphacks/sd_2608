pub mod application;
pub mod domain;
pub mod infrastructure;
pub mod ipc;
pub mod ports;

use application::app_service::AppService;
use tauri::Manager;

pub fn configure<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    configure_with_service(builder, AppService::default())
}

pub fn configure_with_service<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
    service: AppService,
) -> tauri::Builder<R> {
    builder
        .manage(service)
        .invoke_handler(tauri::generate_handler![
            ipc::commands::app_get_snapshot,
            ipc::commands::runtime_start,
            ipc::commands::runtime_stop,
            ipc::commands::face_submit,
            ipc::commands::reminder_respond,
            ipc::commands::settings_update,
            ipc::commands::report_list,
            ipc::commands::report_get,
            ipc::commands::report_retry,
            ipc::commands::data_clear,
        ])
        .on_page_load(|window, payload| {
            if window.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                if let Some(service) = window.try_state::<AppService>() {
                    if let Ok(Some(snapshot)) = service.stop_for_lifecycle() {
                        ipc::events::publish(window.app_handle(), &snapshot);
                    }
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                if let Some(service) = window.try_state::<AppService>() {
                    let _ = service.stop_for_lifecycle();
                }
            }
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure(tauri::Builder::default())
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
