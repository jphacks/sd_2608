//! 試作版 activity/windows.rs を移植。Store・Tauri・UI への依存を持たない。
use crate::ports::activity::{
    ActivityReading, Foreground, WindowInfo, elapsed_input_ms, is_excluded_app,
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            StationsAndDesktops::{
                CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
                GetUserObjectInformationW, HDESK, OpenInputDesktop, UOI_NAME,
            },
            SystemInformation::GetTickCount64,
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
        },
        UI::{
            Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
            WindowsAndMessaging::{
                GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
            },
        },
    },
    core::PWSTR,
};

struct Desktop(HDESK);
impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.0);
        }
    }
}
struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
fn input_desktop_is_default() -> bool {
    // SAFETY: 所有する出力バッファと RAII により閉じるデスクトップハンドルだけを使用。
    unsafe {
        let Ok(handle) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return false;
        };
        let desktop = Desktop(handle);
        let mut name = [0u16; 256];
        if GetUserObjectInformationW(
            HANDLE(desktop.0.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            std::mem::size_of_val(&name) as u32,
            None,
        )
        .is_err()
        {
            return false;
        }
        let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("default")
    }
}
fn app_name(process_id: u32) -> Option<String> {
    // SAFETY: 所有ハンドルとサイズを明示した UTF-16 出力バッファを使用。
    unsafe {
        let process =
            Process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?);
        let mut path = vec![0u16; 32_768];
        let mut length = path.len() as u32;
        QueryFullProcessImageNameW(
            process.0,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
        .ok()?;
        let path = String::from_utf16_lossy(&path[..length as usize]);
        // フルパスは保持せず、ファイル名のみ返す。
        path.rsplit(['\\', '/'])
            .next()
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    }
}
fn foreground(excluded_apps: &[String]) -> Foreground {
    if !input_desktop_is_default() {
        return Foreground::Restricted;
    }
    // SAFETY: HWND/PID を検証し、取得後にも同じ前面ウィンドウか確認する。
    // 自プロセスは GetWindowTextW より前に除外し、UI への同期メッセージ待ちを避ける。
    unsafe {
        let window = GetForegroundWindow();
        if window.0.is_null() {
            return Foreground::Unavailable;
        }
        let mut process_id = 0;
        if GetWindowThreadProcessId(window, Some(&mut process_id)) == 0 || process_id == 0 {
            return Foreground::Unavailable;
        }
        if process_id == std::process::id() {
            return Foreground::Pet;
        }
        let Some(app_name) = app_name(process_id) else {
            return Foreground::Unavailable;
        };
        // 認証・設定の除外対象ではタイトル自体を読み取らない。
        if is_excluded_app(&app_name, excluded_apps) {
            return Foreground::Excluded;
        }
        let mut class_name = [0u16; 256];
        let class_length = GetClassNameW(window, &mut class_name).max(0) as usize;
        if class_length == 0 {
            return Foreground::Unavailable;
        }
        if matches!(
            String::from_utf16_lossy(&class_name[..class_length]).as_str(),
            "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Progman" | "WorkerW"
        ) {
            return Foreground::Excluded;
        }
        let mut title = [0u16; 1_024];
        // 空タイトルも有効。HWND の消失や切替は後段の再確認で捨てる。
        let length = GetWindowTextW(window, &mut title).max(0) as usize;
        let mut current_pid = 0;
        if GetForegroundWindow() != window
            || GetWindowThreadProcessId(window, Some(&mut current_pid)) == 0
            || current_pid != process_id
        {
            return Foreground::Unavailable;
        }
        if !input_desktop_is_default() {
            return Foreground::Restricted;
        }
        Foreground::External(WindowInfo {
            window_id: format!("{:x}", window.0 as usize),
            process_id,
            app_name,
            window_title: String::from_utf16_lossy(&title[..length]),
        })
    }
}
pub fn collect(excluded_apps: &[String]) -> ActivityReading {
    let mut input = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: LASTINPUTINFO の cbSize と出力領域は API の要件を満たす。
    let idle_ms = unsafe {
        GetLastInputInfo(&mut input)
            .as_bool()
            .then(|| elapsed_input_ms(GetTickCount64() as u32, input.dwTime))
            .flatten()
    };
    ActivityReading {
        idle_ms,
        foreground: foreground(excluded_apps),
    }
}
