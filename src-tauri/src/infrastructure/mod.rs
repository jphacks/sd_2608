#[cfg(windows)]
pub mod windows;

use crate::ports::activity::{ActivityError, ActivityReading, ActivitySource};

pub struct NativeActivitySource;
impl ActivitySource for NativeActivitySource {
    fn read(&self, excluded_apps: &[String]) -> Result<ActivityReading, ActivityError> {
        #[cfg(windows)]
        {
            Ok(windows::activity::collect(excluded_apps))
        }
        #[cfg(not(windows))]
        {
            let _ = excluded_apps;
            Err(ActivityError::Unavailable)
        }
    }
}
pub mod providers;
pub mod storage;
