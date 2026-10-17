use super::{EndReason, Time};
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub id: u64,
    pub started_at: Time,
    pub ended_at: Option<Time>,
    pub end_reason: Option<EndReason>,
    pub elapsed_ms: u64,
    pub report_requested: bool,
}
impl Session {
    pub fn new(id: u64, now: Time) -> Self {
        Self {
            id,
            started_at: now,
            ended_at: None,
            end_reason: None,
            elapsed_ms: 0,
            report_requested: false,
        }
    }
    pub fn update(&mut self, now: Time) {
        if self.ended_at.is_none() {
            self.elapsed_ms = now.elapsed_ms.saturating_sub(self.started_at.elapsed_ms);
        }
    }
    pub fn end(&mut self, at: Time, reason: EndReason) {
        self.elapsed_ms = at.elapsed_ms.saturating_sub(self.started_at.elapsed_ms);
        self.ended_at = Some(Time {
            utc_ms: self.started_at.utc_ms.saturating_add(self.elapsed_ms),
            elapsed_ms: self.started_at.elapsed_ms.saturating_add(self.elapsed_ms),
        });
        self.end_reason = Some(reason);
    }
}
