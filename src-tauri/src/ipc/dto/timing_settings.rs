use super::*;
use crate::domain::timings::Timings;

wire_struct!(TimingSettings {
    absence_ms: SafeInt,
    report_delay_ms: SafeInt,
    first_ms: SafeInt,
    advance_notice_lead_ms: SafeInt,
    first_limit_ms: SafeInt,
    snooze_ms: SafeInt,
    cooldown_ms: SafeInt,
    hard_ms: SafeInt,
    hard_repeat_ms: SafeInt,
    yes_grace_ms: SafeInt,
    idle_ms: SafeInt,
    switch_window_ms: SafeInt,
    switch_idle_ms: SafeInt,
});
wire_struct!(TimingProfiles {
    normal: TimingSettings,
    demo: TimingSettings,
});
impl Default for TimingProfiles {
    fn default() -> Self {
        Self {
            normal: Timings::NORMAL.into(),
            demo: Timings::DEMO.into(),
        }
    }
}
impl From<Timings> for TimingSettings {
    fn from(value: Timings) -> Self {
        Self {
            absence_ms: SafeInt::try_from(value.absence_ms).expect("valid default timing"),
            report_delay_ms: SafeInt::try_from(value.report_delay_ms)
                .expect("valid default timing"),
            first_ms: SafeInt::try_from(value.first_ms).expect("valid default timing"),
            advance_notice_lead_ms: SafeInt::try_from(value.advance_notice_lead_ms)
                .expect("valid default timing"),
            first_limit_ms: SafeInt::try_from(value.first_limit_ms).expect("valid default timing"),
            snooze_ms: SafeInt::try_from(value.snooze_ms).expect("valid default timing"),
            cooldown_ms: SafeInt::try_from(value.cooldown_ms).expect("valid default timing"),
            hard_ms: SafeInt::try_from(value.hard_ms).expect("valid default timing"),
            hard_repeat_ms: SafeInt::try_from(value.hard_repeat_ms).expect("valid default timing"),
            yes_grace_ms: SafeInt::try_from(value.yes_grace_ms).expect("valid default timing"),
            idle_ms: SafeInt::try_from(value.idle_ms).expect("valid default timing"),
            switch_window_ms: SafeInt::try_from(value.switch_window_ms)
                .expect("valid default timing"),
            switch_idle_ms: SafeInt::try_from(value.switch_idle_ms).expect("valid default timing"),
        }
    }
}
impl TimingProfiles {
    pub fn for_profile(&self, profile: TimingProfile) -> Timings {
        match profile {
            TimingProfile::Normal => &self.normal,
            TimingProfile::Demo => &self.demo,
        }
        .to_domain()
    }
    pub fn validate(&self) -> Result<(), ApiError> {
        self.normal.validate()?;
        self.demo.validate()
    }
}
impl TimingSettings {
    pub fn to_domain(&self) -> Timings {
        Timings {
            absence_ms: self.absence_ms.get(),
            report_delay_ms: self.report_delay_ms.get(),
            first_ms: self.first_ms.get(),
            advance_notice_lead_ms: self.advance_notice_lead_ms.get(),
            first_limit_ms: self.first_limit_ms.get(),
            snooze_ms: self.snooze_ms.get(),
            cooldown_ms: self.cooldown_ms.get(),
            hard_ms: self.hard_ms.get(),
            hard_repeat_ms: self.hard_repeat_ms.get(),
            yes_grace_ms: self.yes_grace_ms.get(),
            idle_ms: self.idle_ms.get(),
            switch_window_ms: self.switch_window_ms.get(),
            switch_idle_ms: self.switch_idle_ms.get(),
        }
    }
    fn validate(&self) -> Result<(), ApiError> {
        let message = |text| ApiError::new(ErrorCode::Validation, text);
        let positive = [
            self.absence_ms,
            self.first_ms,
            self.first_limit_ms,
            self.snooze_ms,
            self.hard_ms,
            self.hard_repeat_ms,
            self.idle_ms,
            self.switch_window_ms,
            self.switch_idle_ms,
        ];
        let zero_allowed = [
            self.report_delay_ms,
            self.advance_notice_lead_ms,
            self.cooldown_ms,
            self.yes_grace_ms,
        ];
        if positive.iter().any(|v| v.get() < 1_000)
            || positive
                .iter()
                .chain(zero_allowed.iter())
                .any(|v| v.get() > 86_400_000 || v.get() % 1_000 != 0)
        {
            return Err(message(
                "時間は1秒単位で24時間以内にしてください。予告・離席後の待ち時間・再通知の抑制・作成後の猶予は0秒にできます。",
            ));
        }
        if self.advance_notice_lead_ms > self.first_ms {
            return Err(message("予告時間は休憩の目安以下にしてください。"));
        }
        if self.first_ms > self.first_limit_ms || self.first_limit_ms > self.hard_ms {
            return Err(message(
                "休憩の目安 ≦ 初回通知の上限 ≦ 強調通知の開始時間にしてください。",
            ));
        }
        if self.cooldown_ms > self.snooze_ms {
            return Err(message(
                "再通知の抑制時間は再通知の上限以下にしてください。",
            ));
        }
        if self.switch_idle_ms > self.switch_window_ms {
            return Err(message(
                "切り替え後の無操作時間は切り替えの判定期間以下にしてください。",
            ));
        }
        Ok(())
    }
}
