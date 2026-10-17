#[cfg(not(windows))]
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy)]
pub struct ClockReading {
    pub utc_ms: u64,
    pub elapsed_ms: u64,
}

pub trait Clock: Send + Sync {
    fn read(&self) -> ClockReading;
}

pub struct SystemClock {
    #[cfg(not(windows))]
    origin: Instant,
    #[cfg(windows)]
    origin: u64,
}
impl Default for SystemClock {
    fn default() -> Self {
        Self {
            #[cfg(not(windows))]
            origin: Instant::now(),
            #[cfg(windows)]
            // スリープを含み、手動の日時変更に影響されない OS の経過時間。
            origin: unsafe { windows::Win32::System::SystemInformation::GetTickCount64() },
        }
    }
}
impl Clock for SystemClock {
    fn read(&self) -> ClockReading {
        ClockReading {
            utc_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
            #[cfg(windows)]
            elapsed_ms: unsafe { windows::Win32::System::SystemInformation::GetTickCount64() }
                .saturating_sub(self.origin),
            #[cfg(not(windows))]
            elapsed_ms: self
                .origin
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        }
    }
}
