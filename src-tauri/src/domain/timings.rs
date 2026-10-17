#[derive(Clone, Copy, Debug)]
pub struct Timings {
    pub absence_ms: u64,
    pub report_delay_ms: u64,
    pub first_ms: u64,
    pub advance_notice_lead_ms: u64,
    pub first_limit_ms: u64,
    pub snooze_ms: u64,
    pub cooldown_ms: u64,
    pub hard_ms: u64,
    pub hard_repeat_ms: u64,
    pub yes_grace_ms: u64,
    pub idle_ms: u64,
    pub switch_window_ms: u64,
    pub switch_idle_ms: u64,
}
pub const FRESH_MS: u64 = 5_000;
impl Timings {
    pub const NORMAL: Self = Self {
        absence_ms: 30_000,
        report_delay_ms: 5 * 60_000,
        first_ms: 30 * 60_000,
        advance_notice_lead_ms: 3 * 60_000,
        first_limit_ms: 35 * 60_000,
        snooze_ms: 10 * 60_000,
        cooldown_ms: 2 * 60_000,
        hard_ms: 60 * 60_000,
        hard_repeat_ms: 5 * 60_000,
        yes_grace_ms: 10 * 60_000,
        idle_ms: 5_000,
        switch_window_ms: 10_000,
        switch_idle_ms: 2_000,
    };
    pub const DEMO: Self = Self {
        absence_ms: 5_000,
        report_delay_ms: 5_000,
        first_ms: 30_000,
        advance_notice_lead_ms: 3_000,
        first_limit_ms: 35_000,
        snooze_ms: 10_000,
        cooldown_ms: 2_000,
        hard_ms: 60_000,
        hard_repeat_ms: 5_000,
        yes_grace_ms: 10_000,
        idle_ms: 2_000,
        switch_window_ms: 5_000,
        switch_idle_ms: 1_000,
    };
}
