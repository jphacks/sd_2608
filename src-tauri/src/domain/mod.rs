//! Windows / Tauri / HTTP / Wire DTO に依存しない在席・通知の判定。
pub mod boundary;
pub mod event;
pub mod history;
#[cfg(test)]
mod history_tests;
pub mod presence;
pub mod reminder;
pub mod report;
#[cfg(test)]
mod report_tests;
pub mod session;
pub mod timings;
use boundary::BoundaryPolicy;
pub use event::{DomainEvent, ReportTrigger};
use presence::PresencePolicy;
use reminder::ReminderPolicy;
pub use session::Session;
use timings::{FRESH_MS, Timings};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Time {
    pub utc_ms: u64,
    pub elapsed_ms: u64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Face {
    pub sequence: u64,
    pub detected: bool,
    pub received_elapsed_ms: u64,
    pub age_at_receipt_ms: u64,
}
impl Face {
    pub fn age(&self, now: u64) -> Option<u64> {
        now.checked_sub(self.received_elapsed_ms)?
            .checked_add(self.age_at_receipt_ms)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowKey {
    pub process_id: u32,
    pub window_id: String,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    External(WindowKey),
    Pet,
    Excluded,
    Restricted,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Activity {
    pub observed_elapsed_ms: u64,
    pub idle_ms: Option<u64>,
    pub target: Target,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Presence {
    Present,
    Uncertain,
    Away,
    Unknown,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PresenceReason {
    StableFace,
    Stabilizing,
    FaceMissing,
    AwayConfirmed,
    MissingInput,
    SensorUnavailable,
    StaleSample,
    ProtectedScreen,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EndReason {
    Away,
    Interrupted,
    Stopped,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BoundaryKind {
    Idle,
    WindowSwitchIdle,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Boundary {
    pub id: u64,
    pub kind: BoundaryKind,
    pub occurred_at: Time,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReminderLevel {
    Normal,
    Hard,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReminderCause {
    Boundary,
    InitialLimit,
    SnoozeLimit,
    HardLimit,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Answer {
    Yes,
    No,
}
#[derive(Clone, Debug, PartialEq)]
pub struct PresenceView {
    pub value: Presence,
    pub reason: PresenceReason,
    pub missing_since: Option<Time>,
    pub away_at: Option<Time>,
    pub interrupted: bool,
}
impl Default for PresenceView {
    fn default() -> Self {
        Self {
            value: Presence::Unknown,
            reason: PresenceReason::MissingInput,
            missing_since: None,
            away_at: None,
            interrupted: false,
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Reminder {
    pub id: u64,
    pub session_id: u64,
    pub level: ReminderLevel,
    pub cause: ReminderCause,
    pub shown_at: Time,
}
#[derive(Clone, Debug, PartialEq)]
pub struct AdvanceNotice {
    pub session_id: u64,
    pub remaining_ms: u64,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DomainError {
    Exhausted,
    StaleReminder,
}

#[derive(Clone)]
pub struct Engine {
    timings: Timings,
    presence_policy: PresencePolicy,
    boundary: BoundaryPolicy,
    reminder: ReminderPolicy,
    pub presence: PresenceView,
    pub session: Option<Session>,
    last_tick: Option<Time>,
    session_serial: u64,
    reminder_serial: u64,
    boundary_serial: u64,
}
impl Engine {
    pub fn new(timings: Timings) -> Self {
        Self {
            timings,
            presence_policy: PresencePolicy::default(),
            boundary: BoundaryPolicy::default(),
            reminder: ReminderPolicy::default(),
            presence: PresenceView::default(),
            session: None,
            last_tick: None,
            session_serial: 0,
            reminder_serial: 0,
            boundary_serial: 0,
        }
    }
    pub fn visible_reminder(&self) -> Option<&Reminder> {
        if self.presence.value == Presence::Present {
            self.reminder.active.as_ref()
        } else {
            None
        }
    }
    /// 最初の30分の目安までの予告。表示を閉じても通知・回答の状態は変更しない。
    pub fn advance_notice(&self) -> Option<AdvanceNotice> {
        if self.presence.value != Presence::Present {
            return None;
        }
        let session = self.session.as_ref().filter(|s| s.ended_at.is_none())?;
        let remaining_ms = self.timings.first_ms.checked_sub(session.elapsed_ms)?;
        if remaining_ms == 0 || remaining_ms > self.timings.advance_notice_lead_ms {
            return None;
        }
        Some(AdvanceNotice {
            session_id: session.id,
            remaining_ms,
        })
    }
    pub fn tick(
        &mut self,
        now: Time,
        face: Option<&Face>,
        activity: Option<&Activity>,
        unavailable_reason: PresenceReason,
    ) -> Result<Vec<DomainEvent>, DomainError> {
        let mut next = self.clone();
        let events = next.advance(now, face, activity, unavailable_reason)?;
        *self = next;
        Ok(events)
    }
    fn advance(
        &mut self,
        now: Time,
        face: Option<&Face>,
        activity: Option<&Activity>,
        unavailable_reason: PresenceReason,
    ) -> Result<Vec<DomainEvent>, DomainError> {
        let previous_tick = self.last_tick;
        let gap = previous_tick.is_some_and(|last| {
            now.elapsed_ms
                .checked_sub(last.elapsed_ms)
                .is_none_or(|gap| gap > FRESH_MS)
        });
        self.last_tick = Some(now);
        let invalid = if gap {
            Some(PresenceReason::StaleSample)
        } else if activity.is_some_and(|a| a.target == Target::Restricted) {
            Some(PresenceReason::ProtectedScreen)
        } else if face.is_some_and(|f| f.age(now.elapsed_ms).is_none_or(|age| age > FRESH_MS))
            || activity.is_some_and(|a| {
                now.elapsed_ms
                    .checked_sub(a.observed_elapsed_ms)
                    .is_none_or(|age| age > FRESH_MS)
            })
        {
            Some(PresenceReason::StaleSample)
        } else if face.is_none() || activity.is_none() {
            Some(unavailable_reason)
        } else if activity.is_some_and(|a| a.idle_ms.is_none() || a.target == Target::Unavailable) {
            Some(PresenceReason::SensorUnavailable)
        } else {
            None
        };
        self.presence = if let Some(reason) = invalid {
            self.boundary.invalidate();
            self.presence_policy.unknown(face, reason)
        } else {
            self.presence_policy.update(
                now,
                face.expect("validated face"),
                activity.and_then(|a| a.idle_ms).expect("validated idle"),
                self.timings,
            )
        };
        let mut events = vec![];
        let end = if self.presence.value == Presence::Away {
            Some((self.presence.missing_since.unwrap_or(now), EndReason::Away))
        } else if self.presence.value == Presence::Unknown || self.presence.interrupted {
            Some((
                if gap {
                    previous_tick.unwrap_or(now)
                } else {
                    now
                },
                EndReason::Interrupted,
            ))
        } else {
            None
        };
        if let Some((at, reason)) = end {
            if let Some(session) = self.session.as_mut().filter(|s| s.ended_at.is_none()) {
                session.end(at, reason);
                self.reminder = ReminderPolicy::default();
                events.push(DomainEvent::SessionEnded {
                    session: session.clone(),
                    detected_at: now,
                });
                if reason == EndReason::Away && !session.report_requested {
                    session.report_requested = true;
                    events.push(DomainEvent::ReportRequested {
                        session: session.clone(),
                        trigger: ReportTrigger::Away,
                        requested_at: now,
                    });
                }
            }
        }
        if self.presence.value == Presence::Present
            && self.session.as_ref().is_none_or(|s| s.ended_at.is_some())
        {
            self.session_serial = self
                .session_serial
                .checked_add(1)
                .ok_or(DomainError::Exhausted)?;
            let session = Session::new(self.session_serial, now);
            events.push(DomainEvent::SessionStarted(session.clone()));
            self.session = Some(session);
            self.reminder = ReminderPolicy::default();
        }
        if let Some(session) = &mut self.session {
            session.update(now);
        }
        let boundary = if invalid.is_none() {
            activity.and_then(|a| self.boundary.update(a, self.timings))
        } else {
            None
        };
        if let Some(kind) = boundary {
            self.boundary_serial = self
                .boundary_serial
                .checked_add(1)
                .ok_or(DomainError::Exhausted)?;
            events.push(DomainEvent::BoundaryDetected(Boundary {
                id: self.boundary_serial,
                kind,
                occurred_at: now,
            }));
        }
        if self.presence.value == Presence::Present {
            if let Some(session) = &self.session {
                if let Some((level, cause)) =
                    self.reminder
                        .due(now, session.elapsed_ms, boundary.is_some(), self.timings)
                {
                    self.reminder_serial = self
                        .reminder_serial
                        .checked_add(1)
                        .ok_or(DomainError::Exhausted)?;
                    self.reminder.active = Some(Reminder {
                        id: self.reminder_serial,
                        session_id: session.id,
                        level,
                        cause,
                        shown_at: now,
                    });
                }
            }
        }
        Ok(events)
    }
    pub fn answer(
        &mut self,
        session_id: u64,
        reminder_id: u64,
        answer: Answer,
        now: Time,
    ) -> Result<Vec<DomainEvent>, DomainError> {
        if self
            .visible_reminder()
            .is_none_or(|r| r.session_id != session_id || r.id != reminder_id)
        {
            return Err(DomainError::StaleReminder);
        }
        let session = self
            .session
            .as_mut()
            .filter(|s| s.ended_at.is_none())
            .ok_or(DomainError::StaleReminder)?;
        self.reminder
            .answer(answer, now, session.elapsed_ms, self.timings);
        let mut events = vec![];
        if answer == Answer::Yes && !session.report_requested {
            session.report_requested = true;
            events.push(DomainEvent::ReportRequested {
                session: session.clone(),
                trigger: ReportTrigger::Yes,
                requested_at: now,
            });
        }
        Ok(events)
    }
    pub fn stop(&mut self, now: Time) -> Vec<DomainEvent> {
        let mut events = vec![];
        if let Some(session) = self.session.as_mut().filter(|s| s.ended_at.is_none()) {
            session.end(now, EndReason::Stopped);
            events.push(DomainEvent::SessionEnded {
                session: session.clone(),
                detected_at: now,
            });
        }
        self.reminder = ReminderPolicy::default();
        self.boundary.invalidate();
        self.presence = self
            .presence_policy
            .unknown(None, PresenceReason::SensorUnavailable);
        events
    }
}

#[cfg(test)]
mod tests;
