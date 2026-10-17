use super::*;
use serde_json::json;
use std::hash::{DefaultHasher, Hash, Hasher};
fn sample(sequence: u64, observed_at: u64) -> FaceInput {
    serde_json::from_value(json!({"trackingId":"tracking","sequence":sequence,"observedAt":observed_at,"source":"camera","kind":"sample","faceDetected":true})).unwrap()
}
fn accept(
    ingress: &mut FaceIngress,
    input: &FaceInput,
    utc_ms: u64,
    elapsed_ms: u64,
    revision: u64,
) -> Result<(FaceReceipt, bool), ApiError> {
    let mut hash = DefaultHasher::new();
    serde_json::to_string(input).unwrap().hash(&mut hash);
    ingress.accept(
        input,
        [hash.finish(), 0],
        ClockReading { utc_ms, elapsed_ms },
        TimingProfile::Normal,
        SafeInt::try_from(revision).unwrap(),
    )
}
#[test]
fn accepted_input_retains_only_boolean_and_metadata_and_supports_no_face() {
    let mut ingress = FaceIngress::default();
    assert_eq!(ingress.phase(), CameraPhase::Waiting);
    let (receipt, changed) = accept(&mut ingress, &sample(1, 10_000), 10_000, 100, 2).unwrap();
    assert!(changed);
    assert_eq!(receipt.accepted_sequence.get(), 1);
    assert_eq!(receipt.snapshot_revision.get(), 2);
    assert_eq!(ingress.phase(), CameraPhase::Running);
    assert!(ingress.latest.as_ref().unwrap().face_detected);
    let mut next = sample(2, 10_001);
    if let FaceInput::Sample { face_detected, .. } = &mut next {
        *face_detected = false;
    }
    accept(&mut ingress, &next, 10_001, 101, 3).unwrap();
    assert_eq!(ingress.phase(), CameraPhase::Running);
    assert!(!ingress.latest.as_ref().unwrap().face_detected);
}
#[test]
fn identical_old_retries_return_the_original_receipt_without_refreshing_the_input() {
    let mut ingress = FaceIngress::default();
    let first = sample(1, 10_000);
    let receipt = accept(&mut ingress, &first, 10_000, 100, 2).unwrap().0;
    accept(&mut ingress, &sample(2, 10_001), 10_001, 101, 3).unwrap();
    let previous = ingress.latest.clone();
    let (retried, changed) = accept(&mut ingress, &first, 30_000, 20_100, 9).unwrap();
    assert_eq!(receipt, retried);
    assert!(!changed);
    assert_eq!(ingress.latest, previous);
    ingress.expire(20_100);
    assert_eq!(ingress.phase(), CameraPhase::Error);
    accept(&mut ingress, &first, 40_000, 30_100, 10).unwrap();
    assert!(ingress.latest.is_none());
    let mut conflict = first;
    if let FaceInput::Sample { face_detected, .. } = &mut conflict {
        *face_detected = false;
    }
    assert_eq!(
        accept(&mut ingress, &conflict, 10_000, 100, 10)
            .unwrap_err()
            .code,
        ErrorCode::Validation
    );
}
#[test]
fn validates_sequence_monotonic_observed_time_and_five_second_two_second_boundaries() {
    for (observed, valid) in [
        (5_000, true),
        (4_999, false),
        (12_000, true),
        (12_001, false),
    ] {
        let mut ingress = FaceIngress::default();
        assert_eq!(
            accept(&mut ingress, &sample(1, observed), 10_000, 100, 1).is_ok(),
            valid
        );
    }
    let mut ingress = FaceIngress::default();
    assert!(accept(&mut ingress, &sample(0, 10_000), 10_000, 100, 1).is_err());
    accept(&mut ingress, &sample(2, 10_000), 10_000, 100, 1).unwrap();
    assert!(accept(&mut ingress, &sample(1, 10_000), 10_000, 100, 2).is_err());
    assert!(accept(&mut ingress, &sample(3, 9_999), 10_000, 100, 2).is_err());
}
#[test]
fn expiry_includes_transport_age_and_rejects_a_reversed_monotonic_clock() {
    let mut ingress = FaceIngress::default();
    accept(&mut ingress, &sample(1, 5_000), 10_000, 100, 1).unwrap();
    ingress.expire(100);
    assert!(ingress.latest.is_some());
    ingress.expire(101);
    assert!(ingress.latest.is_none());
    accept(&mut ingress, &sample(2, 12_000), 10_000, 102, 2).unwrap();
    ingress.expire(5_102);
    assert!(ingress.latest.is_some());
    ingress.expire(5_103);
    assert!(ingress.latest.is_none());
    accept(&mut ingress, &sample(3, 12_000), 12_000, 6_000, 3).unwrap();
    ingress.expire(5_999);
    assert!(ingress.latest.is_none());
}
#[test]
fn unavailable_is_distinct_from_no_face_and_new_samples_can_recover() {
    for (reason, phase) in [
        (UnavailableReason::Denied, CameraPhase::Error),
        (UnavailableReason::DeviceError, CameraPhase::Error),
        (UnavailableReason::Stopped, CameraPhase::Off),
    ] {
        let mut ingress = FaceIngress::default();
        accept(&mut ingress, &sample(1, 10_000), 10_000, 100, 1).unwrap();
        let input = FaceInput::Unavailable {
            tracking_id: Id::try_from("tracking".to_string()).unwrap(),
            sequence: SafeInt::try_from(2).unwrap(),
            observed_at: SafeInt::try_from(10_000).unwrap(),
            source: FaceSource::Camera,
            reason,
        };
        accept(&mut ingress, &input, 10_000, 100, 2).unwrap();
        assert_eq!(ingress.phase(), phase);
        assert!(ingress.latest.is_none());
        accept(&mut ingress, &sample(3, 10_000), 10_000, 101, 3).unwrap();
        assert_eq!(ingress.phase(), CameraPhase::Running);
    }
}
#[test]
fn manual_is_demo_only_and_cannot_be_mixed_into_a_camera_stream() {
    let mut ingress = FaceIngress::default();
    let mut input = sample(1, 10_000);
    if let FaceInput::Sample { source, .. } = &mut input {
        *source = FaceSource::Manual;
    }
    assert_eq!(
        accept(&mut ingress, &input, 10_000, 100, 1)
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    ingress
        .accept(
            &input,
            [1, 2],
            ClockReading {
                utc_ms: 10_000,
                elapsed_ms: 100,
            },
            TimingProfile::Demo,
            SafeInt::try_from(1).unwrap(),
        )
        .unwrap();
    assert!(accept(&mut ingress, &sample(2, 10_000), 10_000, 100, 2).is_err());
}
#[test]
fn receipt_cache_is_bounded_and_evicted_sequences_cannot_be_reused() {
    let mut ingress = FaceIngress::default();
    for seq in 1..=1_001 {
        accept(&mut ingress, &sample(seq, 10_000), 10_000, 100, seq).unwrap();
    }
    assert_eq!(ingress.receipts.len(), 1_000);
    assert!(accept(&mut ingress, &sample(1, 10_000), 10_000, 100, 1_002).is_err());
    assert!(
        !accept(&mut ingress, &sample(2, 10_000), 10_000, 100, 1_002)
            .unwrap()
            .1
    );
}

#[test]
fn wall_clock_rollback_accepts_fresh_sequences_but_still_rejects_stale_input() {
    let mut ingress = FaceIngress::default();
    accept(&mut ingress, &sample(1, 100_000), 100_000, 0, 1).unwrap();
    // UTC だけを戻す。monotonic は進み、新しいサンプルを受け付ける。
    accept(&mut ingress, &sample(2, 10_000), 10_000, 1_000, 2).unwrap();
    accept(&mut ingress, &sample(3, 11_000), 11_000, 2_000, 3).unwrap();
    assert_eq!(ingress.latest.as_ref().unwrap().sequence, 3);
    assert!(accept(&mut ingress, &sample(4, 10_500), 12_000, 3_000, 4).is_err());
    assert!(accept(&mut ingress, &sample(5, 100_000), 12_000, 3_000, 4).is_err());
    assert_eq!(ingress.latest.as_ref().unwrap().sequence, 3);
}
