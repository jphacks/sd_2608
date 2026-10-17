//! Domain と Wire の変換点。生タイトルを Domain へ渡さない。
use super::*;
use crate::{domain as d, ports::clock::ClockReading};

pub(super) fn timings(profile: TimingProfile) -> d::timings::Timings {
    match profile {
        TimingProfile::Normal => d::timings::Timings::NORMAL,
        TimingProfile::Demo => d::timings::Timings::DEMO,
    }
}
pub(super) fn handle_events(state: &mut State, events: &[d::DomainEvent]) {
    for event in events {
        match event {
            d::DomainEvent::SessionStarted(session) => {
                state.history.begin(session.id, session.started_at)
            }
            d::DomainEvent::SessionEnded { session, .. } => {
                if let Some(end) = session.ended_at {
                    state.history.end(end.elapsed_ms);
                }
            }
            d::DomainEvent::ReportRequested {
                session,
                requested_at,
                ..
            } => {
                state.requested_history = history::requested(state, session, *requested_at).ok();
                state.report_unavailable = true;
            }
            _ => {}
        }
    }
}
pub(super) fn refresh_inputs(state: &mut State, now: ClockReading) {
    state.face.expire(now.elapsed_ms);
    state.snapshot.runtime.camera = state.face.phase();
    if state.activity.as_ref().is_some_and(|sample| {
        now.elapsed_ms
            .checked_sub(sample.elapsed_ms)
            .is_none_or(|age| age > MAX_SAMPLE_AGE_MS)
    }) {
        state.activity = None;
        state.activity_error = Some(ActivityError::Stale);
        state.snapshot.runtime.activity = ActivityPhase::Error;
    }
    if state.activity_error.is_some() {
        state.snapshot.runtime.activity = ActivityPhase::Error;
    }
    let face = state.face.latest.as_ref().map(|sample| d::Face {
        sequence: sample.sequence,
        detected: sample.face_detected,
        received_elapsed_ms: sample.received_elapsed_ms,
        age_at_receipt_ms: sample.age_at_receipt_ms,
    });
    let activity = state.activity.as_ref().map(|sample| d::Activity {
        observed_elapsed_ms: sample.elapsed_ms,
        idle_ms: sample.reading.idle_ms,
        target: match &sample.reading.foreground {
            Foreground::External(window) => d::Target::External(d::WindowKey {
                process_id: window.process_id,
                window_id: window.window_id.clone(),
            }),
            Foreground::Pet => d::Target::Pet,
            Foreground::Excluded => d::Target::Excluded,
            Foreground::Restricted => d::Target::Restricted,
            Foreground::Unavailable => d::Target::Unavailable,
        },
    });
    let reason = if state.face.is_stale() || state.activity_error == Some(ActivityError::Stale) {
        d::PresenceReason::StaleSample
    } else if state.snapshot.runtime.activity == ActivityPhase::Error
        || matches!(state.face.phase(), CameraPhase::Error | CameraPhase::Off)
    {
        d::PresenceReason::SensorUnavailable
    } else {
        d::PresenceReason::MissingInput
    };
    let engine = state
        .domain
        .get_or_insert_with(|| d::Engine::new(timings(state.snapshot.runtime.profile)));
    match engine.tick(
        d::Time {
            utc_ms: now.utc_ms,
            elapsed_ms: now.elapsed_ms,
        },
        face.as_ref(),
        activity.as_ref(),
        reason,
    ) {
        Ok(events) => {
            handle_events(state, &events);
            history::record(state);
            history::checkpoint_away(state);
            project(state);
        }
        Err(_) => projection_error(state),
    }
}
fn number(value: u64) -> SafeInt {
    SafeInt::try_from(value.min(MAX_SAFE_INTEGER)).expect("clamped safe integer")
}
pub(super) fn domain_id(state: &State, kind: &str, serial: u64) -> Result<Id, ApiError> {
    let tracking = state
        .snapshot
        .runtime
        .tracking_id
        .as_ref()
        .ok_or_else(internal)?;
    Id::try_from(format!("{kind}-{}-{serial}", tracking.as_str())).map_err(|_| internal())
}
pub(super) fn project(state: &mut State) {
    let Some(engine) = state.domain.as_ref() else {
        return;
    };
    let presence = &engine.presence;
    state.snapshot.presence = PresenceState {
        value: match presence.value {
            d::Presence::Present => Presence::Present,
            d::Presence::Uncertain => Presence::Uncertain,
            d::Presence::Away => Presence::Away,
            d::Presence::Unknown => Presence::Unknown,
        },
        reason: match presence.reason {
            d::PresenceReason::StableFace => PresenceReason::StableFace,
            d::PresenceReason::Stabilizing => PresenceReason::Stabilizing,
            d::PresenceReason::FaceMissing => PresenceReason::FaceMissing,
            d::PresenceReason::AwayConfirmed => PresenceReason::AwayConfirmed,
            d::PresenceReason::MissingInput => PresenceReason::MissingInput,
            d::PresenceReason::SensorUnavailable => PresenceReason::SensorUnavailable,
            d::PresenceReason::StaleSample => PresenceReason::StaleSample,
            d::PresenceReason::ProtectedScreen => PresenceReason::ProtectedScreen,
        },
        face_missing_since: presence.missing_since.map(|at| number(at.utc_ms)),
        away_detected_at: presence.away_at.map(|at| number(at.utc_ms)),
    };
    let session = engine
        .session
        .as_ref()
        .map(|session| {
            let id = domain_id(state, "session", session.id)?;
            let report_job_id = state
                .snapshot
                .session
                .as_ref()
                .filter(|previous| previous.id == id)
                .and_then(|previous| previous.report_job_id.clone());
            Ok::<_, ApiError>(SittingSession {
                id,
                started_at: number(session.started_at.utc_ms),
                ended_at: session.ended_at.map(|at| number(at.utc_ms)),
                end_reason: session.end_reason.map(|reason| match reason {
                    d::EndReason::Away => EndReason::Away,
                    d::EndReason::Interrupted => EndReason::Interrupted,
                    d::EndReason::Stopped => EndReason::Stopped,
                }),
                elapsed_ms: number(if session.ended_at.is_none() {
                    session.elapsed_ms / 1_000 * 1_000
                } else {
                    session.elapsed_ms
                }),
                report_job_id,
            })
        })
        .transpose();
    let reminder = engine
        .visible_reminder()
        .map(|reminder| {
            Ok::<_, ApiError>(Reminder {
                id: domain_id(state, "reminder", reminder.id)?,
                session_id: domain_id(state, "session", reminder.session_id)?,
                source: ReminderSource::Sitting,
                level: match reminder.level {
                    d::ReminderLevel::Normal => ReminderLevel::Normal,
                    d::ReminderLevel::Hard => ReminderLevel::Hard,
                },
                cause: match reminder.cause {
                    d::ReminderCause::Boundary => ReminderCause::Boundary,
                    d::ReminderCause::InitialLimit => ReminderCause::InitialLimit,
                    d::ReminderCause::SnoozeLimit => ReminderCause::SnoozeLimit,
                    d::ReminderCause::HardLimit => ReminderCause::HardLimit,
                },
                shown_at: number(reminder.shown_at.utc_ms),
            })
        })
        .transpose();
    match (session, reminder) {
        (Ok(session), Ok(reminder)) => {
            state.snapshot.session = session;
            state.snapshot.reminder = reminder;
        }
        _ => {
            projection_error(state);
            return;
        }
    }
    let label = if state.face.source == Some(FaceSource::Manual) {
        "手動テスト（カメラ不使用）："
    } else {
        ""
    };
    let detail = match state.snapshot.presence.reason {
        PresenceReason::ProtectedScreen => "保護画面のため在席を判定できません。",
        PresenceReason::StaleSample => "取得の更新が止まったため連続在席を中断しました。",
        _ if state.snapshot.runtime.activity == ActivityPhase::Error => {
            "PC 情報の全部または一部を取得できません。"
        }
        _ if state.face.phase() == CameraPhase::Error => match state.face.unavailable {
            Some(UnavailableReason::Denied) => "カメラの権限を確認して停止後に再開してください。",
            _ => "カメラまたは顔検出を利用できません。停止後に再開してください。",
        },
        _ if state.face.phase() == CameraPhase::Waiting => "カメラからの顔入力を待っています。",
        _ if state.face.phase() == CameraPhase::Off => "カメラの取得は停止しています。",
        _ => "",
    };
    let report = if state.report_unavailable {
        " レポートの作成要求は発生しましたが、生成は未接続です。カードは作成していません。"
    } else {
        ""
    };
    state.snapshot.warning = Some(ApiError::new(
        ErrorCode::InvalidState,
        &format!("{label}{detail} レポート生成・予約は未接続です（B-06・B-07）。{report}"),
    ));
}
fn projection_error(state: &mut State) {
    state.snapshot.presence = PresenceState {
        value: Presence::Unknown,
        reason: PresenceReason::SensorUnavailable,
        face_missing_since: None,
        away_detected_at: None,
    };
    state.snapshot.session = None;
    state.snapshot.reminder = None;
    state.snapshot.warning = Some(internal());
}
