//! PC センサーの内部入力。IPC DTO ではなく、タイトルを通常 UI へ渡さない。
use std::fmt;

#[derive(Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub window_id: String,
    pub process_id: u32,
    pub app_name: String,
    pub window_title: String,
}
impl fmt::Debug for WindowInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WindowInfo").finish_non_exhaustive()
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Foreground {
    External(WindowInfo),
    Pet,
    Excluded,
    Restricted,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityReading {
    pub idle_ms: Option<u64>,
    pub foreground: Foreground,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivitySample {
    pub observed_at_ms: u64,
    pub elapsed_ms: u64,
    pub reading: ActivityReading,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityError {
    Unavailable,
    Stale,
}
pub trait ActivitySource: Send + Sync + 'static {
    fn read(&self, excluded_apps: &[String]) -> Result<ActivityReading, ActivityError>;
}

pub const MAX_SAMPLE_AGE_MS: u64 = 5_000;

pub fn is_excluded_app(name: &str, excluded_apps: &[String]) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "lockapp.exe" | "logonui.exe" | "winlogon.exe" | "credentialuibroker.exe"
    ) || excluded_apps
        .iter()
        .any(|excluded| name.eq_ignore_ascii_case(excluded))
}

// LASTINPUTINFO は下位32bit。周回を扱い、未来・半周以上の曖昧な値を拒否する。
pub fn elapsed_input_ms(current: u32, last_input: u32) -> Option<u64> {
    let elapsed = current.wrapping_sub(last_input);
    (elapsed <= i32::MAX as u32).then_some(u64::from(elapsed))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ticks_handle_rollover_but_not_future_or_ambiguous_values() {
        assert_eq!(elapsed_input_ms(9_000, 4_000), Some(5_000));
        assert_eq!(elapsed_input_ms(20, u32::MAX - 9), Some(30));
        assert_eq!(elapsed_input_ms(1_000, 1_001), None);
        assert_eq!(elapsed_input_ms(i32::MAX as u32, 0), Some(i32::MAX as u64));
        assert_eq!(elapsed_input_ms(i32::MAX as u32 + 1, 0), None);
    }
    #[test]
    fn exclusions_are_case_insensitive_and_debug_redacts_titles() {
        assert!(is_excluded_app("LockApp.EXE", &[]));
        assert!(is_excluded_app("CredentialUIBroker.exe", &[]));
        assert!(is_excluded_app("PRIVATE.exe", &["private.EXE".into()]));
        assert!(!is_excluded_app("explorer.exe", &[]));
        let window = WindowInfo {
            window_id: "1".into(),
            process_id: 1,
            app_name: "private.exe".into(),
            window_title: "secret-title".into(),
        };
        assert!(!format!("{:?}", Foreground::External(window)).contains("secret"));
    }
}
