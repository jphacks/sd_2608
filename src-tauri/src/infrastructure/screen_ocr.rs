use crate::{application::ocr_bridge::OcrBridge, ports::ocr::*};
use std::sync::Arc;
pub struct NativeScreenOcr(pub Arc<OcrBridge>);
impl ScreenOcr for NativeScreenOcr {
    fn collect(
        &self,
        excluded: &[String],
        current: &(dyn Fn() -> bool + Sync),
    ) -> Result<OcrBatch, ()> {
        #[cfg(windows)]
        {
            capture(&self.0, excluded, current)
        }
        #[cfg(not(windows))]
        {
            let _ = (excluded, current);
            Err(())
        }
    }
}
#[cfg(windows)]
fn capture(
    bridge: &OcrBridge,
    excluded: &[String],
    current: &(dyn Fn() -> bool + Sync),
) -> Result<OcrBatch, ()> {
    use crate::infrastructure::windows::activity::{app_name, input_desktop_is_default};
    use crate::ports::activity::is_excluded_app;
    use base64::Engine;
    use std::time::{Duration, Instant};
    use windows::Win32::{
        Foundation::HWND,
        System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowThreadProcessId,
            IsIconic, IsWindow, IsWindowVisible, WS_EX_LAYERED,
        },
    };
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED).map_err(|_| ())?;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    if !current() || !input_desktop_is_default() {
        return Err(());
    }
    let all = xcap::Window::all().map_err(|_| ())?;
    let mut batch = OcrBatch::default();
    let began = Instant::now();
    for window in all {
        if !current() || !input_desktop_is_default() {
            return Err(());
        }
        let Ok(pid) = window.pid() else {
            continue;
        };
        let Some(app) = app_name(pid) else {
            continue;
        };
        if pid == std::process::id() || is_excluded_app(&app, excluded) {
            continue;
        }
        if began.elapsed() >= Duration::from_secs(90) {
            batch.unavailable += 1;
            continue;
        }
        let result = (|| {
            let hwnd = HWND(window.id().map_err(|_| ())? as usize as *mut _);
            let title = window.title().map_err(|_| ())?;
            let valid = || unsafe {
                let mut actual_pid = 0;
                let mut affinity = 0;
                let affinity_result = GetWindowDisplayAffinity(hwnd, &mut affinity);
                let layered = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_LAYERED.0 != 0;
                IsWindow(Some(hwnd)).as_bool()
                    && IsWindowVisible(hwnd).as_bool()
                    && !IsIconic(hwnd).as_bool()
                    && GetWindowThreadProcessId(hwnd, Some(&mut actual_pid)) != 0
                    && actual_pid == pid
                    && app_name(pid).as_ref() == Some(&app)
                    && input_desktop_is_default()
                    && affinity == 0
                    && !(layered && affinity_result.is_err())
                    && window.title().ok().as_ref() == Some(&title)
            };
            let (width, height) = (
                window.width().map_err(|_| ())?,
                window.height().map_err(|_| ())?,
            );
            if width == 0
                || height == 0
                || u64::from(width) * u64::from(height) > 12_000_000
                || !valid()
            {
                return Err(());
            }
            let image = window.capture_image().map_err(|_| ())?;
            if !current() || !valid() || image.width() != width || image.height() != height {
                return Err(());
            }
            let mut bytes = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut bytes, image::ImageFormat::Png)
                .map_err(|_| ())?;
            if bytes.get_ref().len() > 12_000_000 {
                return Err(());
            }
            let encoded = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
            );
            let within_deadline = || current() && began.elapsed() < Duration::from_secs(90);
            let text = bridge.recognize(encoded, &within_deadline)?;
            Ok(OcrWindow {
                key: crate::domain::WindowKey {
                    process_id: pid,
                    window_id: format!("{:x}", hwnd.0 as usize),
                },
                app_name: app,
                title,
                text,
            })
        })();
        match result {
            Ok(window) => batch.windows.push(window),
            Err(()) => batch.unavailable += 1,
        }
    }
    Ok(batch)
}
