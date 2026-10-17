use super::dto::AppSnapshot;
use tauri::{Emitter, Runtime};

pub const SNAPSHOT_EVENT: &str = "app://snapshot";
pub fn publish<R: Runtime>(app: &tauri::AppHandle<R>, snapshot: &AppSnapshot) {
    // 状態の正本は AppService。通知を取りこぼしても次の snapshot 取得で回復できる。
    if app.emit_to("main", SNAPSHOT_EVENT, snapshot).is_err() {
        eprintln!("Could not publish application snapshot");
    }
}
