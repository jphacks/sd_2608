//! 顔入力の受付と鮮度。連続在席や通知を判定しない。
use crate::{ipc::dto::*, ports::clock::ClockReading};
use std::collections::VecDeque;

#[derive(Clone, PartialEq, Debug)]
pub struct FaceObservation {
    pub sequence: u64,
    pub face_detected: bool,
    pub source: FaceSource,
    pub observed_at_ms: u64,
    pub received_elapsed_ms: u64,
    pub age_at_receipt_ms: u64,
}
#[derive(Default)]
pub struct FaceIngress {
    pub latest: Option<FaceObservation>,
    pub source: Option<FaceSource>,
    pub unavailable: Option<UnavailableReason>,
    last_sequence: u64,
    last_observed: Option<u64>,
    receipts: VecDeque<(SafeInt, [u64; 2], FaceReceipt)>,
    stale: bool,
}
impl FaceInput {
    pub fn tracking_id(&self) -> &Id {
        match self {
            Self::Sample { tracking_id, .. } | Self::Unavailable { tracking_id, .. } => tracking_id,
        }
    }
    fn metadata(&self) -> (SafeInt, SafeInt, FaceSource) {
        match self {
            Self::Sample {
                sequence,
                observed_at,
                source,
                ..
            }
            | Self::Unavailable {
                sequence,
                observed_at,
                source,
                ..
            } => (*sequence, *observed_at, *source),
        }
    }
}
impl FaceIngress {
    pub fn accept(
        &mut self,
        input: &FaceInput,
        fingerprint: [u64; 2],
        now: ClockReading,
        profile: TimingProfile,
        revision: SafeInt,
    ) -> Result<(FaceReceipt, bool), ApiError> {
        let (sequence, observed_at, source) = input.metadata();
        if source == FaceSource::Manual && profile != TimingProfile::Demo {
            return Err(ApiError::new(
                ErrorCode::PermissionDenied,
                "手動の顔入力はデモモードだけで利用できます。",
            ));
        }
        if let Some((_, previous, receipt)) =
            self.receipts.iter().find(|(seq, _, _)| *seq == sequence)
        {
            return if *previous == fingerprint {
                Ok((receipt.clone(), false))
            } else {
                Err(ApiError::validation())
            };
        }
        if sequence.get() <= self.last_sequence
            || self
                .last_observed
                .is_some_and(|last| observed_at.get() < last)
            || self.source.is_some_and(|previous| previous != source)
            || now.utc_ms.saturating_sub(observed_at.get()) > 5_000
            || observed_at.get().saturating_sub(now.utc_ms) > 2_000
        {
            return Err(ApiError::validation());
        }
        self.latest = match input {
            FaceInput::Sample { face_detected, .. } => Some(FaceObservation {
                sequence: sequence.get(),
                face_detected: *face_detected,
                source,
                observed_at_ms: observed_at.get(),
                received_elapsed_ms: now.elapsed_ms,
                age_at_receipt_ms: now.utc_ms.saturating_sub(observed_at.get()),
            }),
            FaceInput::Unavailable { .. } => None,
        };
        self.unavailable = match input {
            FaceInput::Unavailable { reason, .. } => Some(*reason),
            _ => None,
        };
        self.source = Some(source);
        self.stale = false;
        self.last_sequence = sequence.get();
        self.last_observed = Some(observed_at.get());
        let receipt = FaceReceipt {
            accepted_sequence: sequence,
            snapshot_revision: revision,
        };
        self.receipts
            .push_back((sequence, fingerprint, receipt.clone()));
        if self.receipts.len() > 1_000 {
            self.receipts.pop_front();
        }
        Ok((receipt, true))
    }
    pub fn expire(&mut self, elapsed_ms: u64) {
        if self.latest.as_ref().is_some_and(|sample| {
            elapsed_ms
                .checked_sub(sample.received_elapsed_ms)
                .and_then(|age| age.checked_add(sample.age_at_receipt_ms))
                .is_none_or(|age| age > 5_000)
        }) {
            self.latest = None;
            self.stale = true;
        }
    }
    pub fn phase(&self) -> CameraPhase {
        if self.latest.is_some() {
            CameraPhase::Running
        } else if self.stale {
            CameraPhase::Error
        } else {
            match self.unavailable {
                Some(UnavailableReason::Stopped) => CameraPhase::Off,
                Some(_) => CameraPhase::Error,
                None => CameraPhase::Waiting,
            }
        }
    }
    pub fn is_stale(&self) -> bool {
        self.stale
    }
}

#[cfg(test)]
mod tests;
