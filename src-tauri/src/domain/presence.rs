use super::{Face, Presence, PresenceReason, PresenceView, Time, timings::Timings};
use std::collections::VecDeque;

#[derive(Clone, Default)]
pub struct PresencePolicy {
    votes: VecDeque<bool>,
    last_sequence: Option<u64>,
    missing_since: Option<Time>,
    away_at: Option<Time>,
}
impl PresencePolicy {
    pub fn unknown(&mut self, face: Option<&Face>, reason: PresenceReason) -> PresenceView {
        self.votes.clear();
        self.missing_since = None;
        self.away_at = None;
        if let Some(face) = face {
            self.last_sequence = Some(face.sequence);
        }
        PresenceView {
            value: Presence::Unknown,
            reason,
            missing_since: None,
            away_at: None,
            interrupted: true,
        }
    }
    pub fn update(
        &mut self,
        now: Time,
        face: &Face,
        idle_ms: u64,
        timings: Timings,
    ) -> PresenceView {
        if self.last_sequence.is_none_or(|last| face.sequence > last) {
            self.last_sequence = Some(face.sequence);
            self.votes.push_back(face.detected);
            if self.votes.len() > 5 {
                self.votes.pop_front();
            }
            if face.detected {
                self.missing_since = None;
            } else if self.missing_since.is_none() {
                let age = face.age(now.elapsed_ms).unwrap_or(0);
                self.missing_since = Some(Time {
                    utc_ms: now.utc_ms.saturating_sub(age),
                    elapsed_ms: now.elapsed_ms.saturating_sub(age),
                });
            }
        }
        let stable = face.detected
            && self.votes.len() == 5
            && self.votes.iter().filter(|v| **v).count() >= 3;
        if stable {
            self.away_at = None;
        }
        let long_missing = self.missing_since.is_some_and(|since| {
            now.elapsed_ms.saturating_sub(since.elapsed_ms) >= timings.absence_ms
        });
        if self.away_at.is_none() && long_missing && idle_ms >= timings.absence_ms {
            self.away_at = Some(now);
        }
        let (value, reason) = if stable {
            (Presence::Present, PresenceReason::StableFace)
        } else if self.away_at.is_some() && !face.detected {
            (Presence::Away, PresenceReason::AwayConfirmed)
        } else if face.detected {
            (Presence::Uncertain, PresenceReason::Stabilizing)
        } else {
            (Presence::Uncertain, PresenceReason::FaceMissing)
        };
        PresenceView {
            value,
            reason,
            missing_since: self.missing_since,
            away_at: self.away_at,
            interrupted: long_missing && self.away_at.is_none(),
        }
    }
}
