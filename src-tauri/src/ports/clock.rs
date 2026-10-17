use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy)]
pub struct ClockReading {
    pub utc_ms: u64,
    pub elapsed_ms: u64,
}

pub trait Clock: Send + Sync {
    fn read(&self) -> ClockReading;
}

pub struct SystemClock {
    origin: Instant,
}
impl Default for SystemClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
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
            elapsed_ms: self
                .origin
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        }
    }
}
