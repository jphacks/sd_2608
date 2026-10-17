use super::{Answer, Reminder, ReminderCause, ReminderLevel, Time, timings::Timings};

#[derive(Clone, Copy)]
struct Answered {
    answer: Answer,
    at: u64,
    hard: bool,
}
#[derive(Clone, Default)]
pub struct ReminderPolicy {
    pub active: Option<Reminder>,
    answered: Option<Answered>,
    hard_seen: bool,
}
impl ReminderPolicy {
    pub fn due(
        &mut self,
        now: Time,
        elapsed: u64,
        boundary: bool,
        timings: Timings,
    ) -> Option<(ReminderLevel, ReminderCause)> {
        let hard = elapsed >= timings.hard_ms;
        if let Some(active) = &mut self.active {
            if hard {
                active.level = ReminderLevel::Hard;
                active.cause = ReminderCause::HardLimit;
                self.hard_seen = true;
            }
            return None;
        }
        if hard && !self.hard_seen {
            self.hard_seen = true;
            return Some((ReminderLevel::Hard, ReminderCause::HardLimit));
        }
        let cause = match self.answered {
            None if elapsed >= timings.first_ms && boundary => Some(ReminderCause::Boundary),
            None if elapsed >= timings.first_limit_ms => Some(ReminderCause::InitialLimit),
            Some(answered) => {
                let since = now.elapsed_ms.saturating_sub(answered.at);
                match answered.answer {
                    Answer::Yes if since >= timings.yes_grace_ms => {
                        Some(ReminderCause::SnoozeLimit)
                    }
                    Answer::No if answered.hard && since >= timings.hard_repeat_ms => {
                        Some(ReminderCause::HardLimit)
                    }
                    Answer::No if !answered.hard && boundary && since >= timings.cooldown_ms => {
                        Some(ReminderCause::Boundary)
                    }
                    Answer::No if !answered.hard && since >= timings.snooze_ms => {
                        Some(ReminderCause::SnoozeLimit)
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        cause.map(|cause| {
            (
                if hard {
                    ReminderLevel::Hard
                } else {
                    ReminderLevel::Normal
                },
                if hard {
                    ReminderCause::HardLimit
                } else {
                    cause
                },
            )
        })
    }
    pub fn answer(&mut self, answer: Answer, now: Time, elapsed: u64, timings: Timings) {
        self.active = None;
        let hard = elapsed >= timings.hard_ms;
        self.answered = Some(Answered {
            answer,
            at: now.elapsed_ms,
            hard,
        });
        if hard {
            self.hard_seen = true;
        }
    }
}
