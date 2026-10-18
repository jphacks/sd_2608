use super::*;
const MINUTE: u64 = 60_000;
#[test]
fn advance_notice_uses_monotonic_first_cycle_bounds_in_normal_and_demo() {
    for timings in [Timings::NORMAL, Timings::DEMO] {
        let mut h = Harness::new(timings);
        h.stable();
        let from = timings.first_ms - timings.advance_notice_lead_ms;
        h.until(from - 1);
        assert!(h.engine.advance_notice().is_none());
        h.until(from);
        let notice = h.engine.advance_notice().unwrap();
        assert_eq!(notice.remaining_ms, timings.advance_notice_lead_ms);
        assert_eq!(notice.session_id, h.engine.session.as_ref().unwrap().id);
        assert!(h.engine.visible_reminder().is_none());
        h.time.utc_ms = 0; // 壁時計の補正は予告の期限に使わない。
        h.until(timings.first_ms - 1);
        assert_eq!(h.engine.advance_notice().unwrap().remaining_ms, 1);
        h.until(timings.first_ms);
        assert!(h.engine.advance_notice().is_none());
        h.until(timings.first_limit_ms);
        assert!(h.engine.visible_reminder().is_some());
        assert!(h.engine.advance_notice().is_none());
        assert_eq!(h.reports(), 0);
    }
}

#[test]
fn advance_notice_hides_on_missing_face_stop_and_interrupted_continuity() {
    let mut h = Harness::new(Timings::DEMO);
    h.stable();
    h.until(27_000);
    assert!(h.engine.advance_notice().is_some());
    h.step(1, false, 0);
    assert!(h.engine.advance_notice().is_none());
    h.step(1, true, 0);
    assert!(h.engine.advance_notice().is_some());
    h.step(6_000, true, 0); // 鮮度切れは旧セッションを中断する。
    assert!(h.engine.advance_notice().is_none());
    h.stable();
    h.until(27_000);
    assert!(h.engine.advance_notice().is_some());
    h.engine.stop(h.time);
    assert!(h.engine.advance_notice().is_none());
}
fn target(name: &str) -> Target {
    Target::External(WindowKey {
        process_id: 1,
        window_id: name.into(),
    })
}
struct Harness {
    engine: Engine,
    time: Time,
    sequence: u64,
    events: Vec<DomainEvent>,
}
impl Harness {
    fn new(timings: Timings) -> Self {
        Self {
            engine: Engine::new(timings),
            time: Time {
                utc_ms: 1_000_000,
                elapsed_ms: 0,
            },
            sequence: 0,
            events: vec![],
        }
    }
    fn step(&mut self, ms: u64, detected: bool, idle: u64) {
        self.time.utc_ms += ms;
        self.time.elapsed_ms += ms;
        self.sequence += 1;
        let face = Face {
            sequence: self.sequence,
            detected,
            received_elapsed_ms: self.time.elapsed_ms,
            age_at_receipt_ms: 0,
        };
        let activity = Activity {
            observed_elapsed_ms: self.time.elapsed_ms,
            idle_ms: Some(idle),
            target: target("editor"),
        };
        self.events.extend(
            self.engine
                .tick(
                    self.time,
                    Some(&face),
                    Some(&activity),
                    PresenceReason::SensorUnavailable,
                )
                .unwrap(),
        );
    }
    fn run(&mut self, mut ms: u64, detected: bool, idle: u64) {
        while ms > 0 {
            let step = ms.min(1_000);
            self.step(step, detected, idle);
            ms -= step;
        }
    }
    fn stable(&mut self) {
        for _ in 0..5 {
            self.step(1_000, true, 0);
        }
        assert_eq!(self.engine.presence.value, Presence::Present);
    }
    fn until(&mut self, elapsed: u64) {
        let current = self.engine.session.as_ref().unwrap().elapsed_ms;
        assert!(elapsed >= current);
        self.run(elapsed - current, true, 0);
    }
    fn answer(&mut self, answer: Answer) -> Vec<DomainEvent> {
        let reminder = self.engine.visible_reminder().unwrap().clone();
        let events = self
            .engine
            .answer(reminder.session_id, reminder.id, answer, self.time)
            .unwrap();
        self.events.extend(events.clone());
        events
    }
    fn reports(&self) -> usize {
        self.events
            .iter()
            .filter(|e| matches!(e, DomainEvent::ReportRequested { .. }))
            .count()
    }
}
#[test]
fn requires_five_distinct_votes_with_three_faces_and_latest_face() {
    let mut h = Harness::new(Timings::NORMAL);
    h.step(1_000, true, 0);
    let face = Face {
        sequence: 1,
        detected: true,
        received_elapsed_ms: h.time.elapsed_ms,
        age_at_receipt_ms: 0,
    };
    for _ in 0..20 {
        h.time.elapsed_ms += 10;
        h.time.utc_ms += 10;
        let activity = Activity {
            observed_elapsed_ms: h.time.elapsed_ms,
            idle_ms: Some(0),
            target: target("editor"),
        };
        h.engine
            .tick(
                h.time,
                Some(&face),
                Some(&activity),
                PresenceReason::SensorUnavailable,
            )
            .unwrap();
    }
    assert_eq!(h.engine.presence.value, Presence::Uncertain);
    assert!(h.engine.session.is_none());
    for detected in [true, false, true] {
        h.step(1_000, detected, 0);
    }
    assert!(h.engine.session.is_none());
    h.step(1_000, true, 0);
    assert_eq!(h.engine.presence.value, Presence::Present);
    h.step(1_000, false, 0);
    assert_eq!(h.engine.presence.value, Presence::Uncertain);
}
#[test]
fn face_present_with_long_idle_stays_seated_and_short_missing_keeps_the_session() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    let id = h.engine.session.as_ref().unwrap().id;
    h.run(10_000, true, 90_000);
    assert_eq!(h.engine.presence.value, Presence::Present);
    h.step(1_000, false, 90_000);
    h.run(29_999, false, 90_000);
    assert_eq!(h.engine.presence.value, Presence::Uncertain);
    assert!(h.engine.session.as_ref().unwrap().ended_at.is_none());
    h.run(3_000, true, 0);
    assert_eq!(h.engine.presence.value, Presence::Present);
    assert_eq!(h.engine.session.as_ref().unwrap().id, id);
    assert_eq!(h.reports(), 0);
}
#[test]
fn away_closes_at_first_missing_face_once_and_input_alone_does_not_resume() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.step(1_000, false, 90_000);
    let missing = h.time;
    h.run(29_999, false, 90_000);
    assert_ne!(h.engine.presence.value, Presence::Away);
    h.step(1, false, 90_000);
    assert_eq!(h.engine.presence.value, Presence::Away);
    assert_eq!(h.engine.presence.away_at, Some(h.time));
    assert_eq!(h.engine.session.as_ref().unwrap().ended_at, Some(missing));
    assert_eq!(h.engine.session.as_ref().unwrap().elapsed_ms, 1_000);
    assert_eq!(h.reports(), 1);
    h.run(10_000, false, 0);
    assert_eq!(h.engine.presence.value, Presence::Away);
    assert_eq!(h.reports(), 1);
    let old = h.engine.session.as_ref().unwrap().id;
    h.run(3_000, true, 0);
    assert_eq!(h.engine.presence.value, Presence::Present);
    assert_ne!(h.engine.session.as_ref().unwrap().id, old);
    assert_eq!(h.engine.session.as_ref().unwrap().elapsed_ms, 0);
}
#[test]
fn active_input_with_missing_face_interrupts_without_a_late_away_report() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.step(1_000, false, 0);
    h.run(30_000, false, 0);
    assert_eq!(h.engine.presence.value, Presence::Uncertain);
    assert_eq!(
        h.engine.session.as_ref().unwrap().end_reason,
        Some(EndReason::Interrupted)
    );
    assert_eq!(h.reports(), 0);
    h.run(30_000, false, 90_000);
    assert_eq!(h.engine.presence.value, Presence::Away);
    assert_eq!(h.reports(), 0);
}
#[test]
fn boundary_after_thirty_minutes_and_fallback_at_thirty_five_have_stable_ids() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.until(30 * MINUTE - 5_000);
    for idle in [1_000, 2_000, 3_000, 4_000] {
        h.step(1_000, true, idle);
        assert!(h.engine.visible_reminder().is_none());
    }
    h.step(1_000, true, 5_000);
    let reminder = h.engine.visible_reminder().unwrap().clone();
    assert_eq!(reminder.cause, ReminderCause::Boundary);
    h.run(5_000, true, 10_000);
    assert_eq!(h.engine.visible_reminder().unwrap().id, reminder.id);
    let mut fallback = Harness::new(Timings::NORMAL);
    fallback.stable();
    fallback.until(35 * MINUTE - 1);
    assert!(fallback.engine.visible_reminder().is_none());
    fallback.step(1, true, 0);
    assert_eq!(
        fallback.engine.visible_reminder().unwrap().cause,
        ReminderCause::InitialLimit
    );
}
#[test]
fn no_needs_a_new_boundary_after_cooldown_or_the_ten_minute_limit() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.until(35 * MINUTE);
    h.answer(Answer::No);
    assert_eq!(h.reports(), 0);
    h.run(2 * MINUTE, true, 90_000);
    assert!(h.engine.visible_reminder().is_none());
    h.step(1_000, true, 0);
    for idle in [1_000, 2_000, 3_000, 4_000, 5_000] {
        h.step(1_000, true, idle);
    }
    assert_eq!(
        h.engine.visible_reminder().unwrap().cause,
        ReminderCause::Boundary
    );
    h.answer(Answer::No);
    h.run(10 * MINUTE - 1, true, 90_000);
    assert!(h.engine.visible_reminder().is_none());
    h.step(1, true, 90_000);
    assert_eq!(
        h.engine.visible_reminder().unwrap().cause,
        ReminderCause::SnoozeLimit
    );
    let mut policy = ReminderPolicy::default();
    let t = Time {
        utc_ms: 1_000_000,
        elapsed_ms: 0,
    };
    policy.answer(Answer::No, t, 35 * MINUTE, Timings::NORMAL);
    assert!(
        policy
            .due(
                Time {
                    elapsed_ms: 2 * MINUTE - 1,
                    ..t
                },
                37 * MINUTE - 1,
                true,
                Timings::NORMAL
            )
            .is_none()
    );
    assert_eq!(
        policy
            .due(
                Time {
                    elapsed_ms: 2 * MINUTE,
                    ..t
                },
                37 * MINUTE,
                true,
                Timings::NORMAL
            )
            .unwrap()
            .1,
        ReminderCause::Boundary
    );
}
#[test]
fn fifty_nine_minute_no_is_overridden_at_sixty_and_later_no_waits_five_minutes() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.until(35 * MINUTE);
    h.until(59 * MINUTE);
    h.answer(Answer::No);
    h.until(60 * MINUTE - 1);
    assert!(h.engine.visible_reminder().is_none());
    h.step(1, true, 0);
    assert_eq!(
        h.engine.visible_reminder().unwrap().level,
        ReminderLevel::Hard
    );
    h.answer(Answer::No);
    h.run(5 * MINUTE - 1, true, 0);
    assert!(h.engine.visible_reminder().is_none());
    h.step(1, true, 0);
    assert_eq!(
        h.engine.visible_reminder().unwrap().cause,
        ReminderCause::HardLimit
    );
    assert_eq!(h.reports(), 0);
}
#[test]
fn hard_upgrade_preserves_id_and_uncertain_only_hides_the_existing_prompt() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.until(35 * MINUTE);
    let old = h.engine.visible_reminder().unwrap().clone();
    h.until(60 * MINUTE - 2_000);
    h.step(1_000, false, 0);
    assert!(h.engine.visible_reminder().is_none());
    assert_eq!(
        h.engine.answer(old.session_id, old.id, Answer::No, h.time),
        Err(DomainError::StaleReminder)
    );
    h.run(1_000, true, 0);
    let current = h.engine.visible_reminder().unwrap();
    assert_eq!(current.id, old.id);
    assert_eq!(current.level, ReminderLevel::Hard);
    assert_eq!(current.shown_at, old.shown_at);
}
#[test]
fn yes_does_not_reset_sitting_and_grace_is_overridden_only_by_the_first_hard_limit() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.until(35 * MINUTE);
    let id = h.engine.session.as_ref().unwrap().id;
    assert_eq!(h.answer(Answer::Yes).len(), 1);
    assert_eq!(h.engine.session.as_ref().unwrap().elapsed_ms, 35 * MINUTE);
    assert_eq!(h.engine.session.as_ref().unwrap().id, id);
    h.until(45 * MINUTE - 1);
    assert!(h.engine.visible_reminder().is_none());
    h.step(1, true, 0);
    h.until(59 * MINUTE);
    assert!(h.answer(Answer::Yes).is_empty());
    h.until(60 * MINUTE);
    assert_eq!(
        h.engine.visible_reminder().unwrap().level,
        ReminderLevel::Hard
    );
    h.answer(Answer::Yes);
    h.until(70 * MINUTE - 1);
    assert!(h.engine.visible_reminder().is_none());
    h.step(1, true, 0);
    assert!(h.engine.visible_reminder().is_some());
    assert_eq!(h.reports(), 1);
    h.step(1_000, false, 90_000);
    h.run(30_000, false, 90_000);
    assert_eq!(h.reports(), 1);
}
#[test]
fn unknown_stale_and_protected_inputs_end_continuity_without_a_report() {
    for kind in [
        "missing",
        "stale_face",
        "stale_pc",
        "protected",
        "unavailable",
        "gap",
        "reverse",
    ] {
        let mut h = Harness::new(Timings::NORMAL);
        h.stable();
        h.until(35 * MINUTE);
        let old = h.engine.session.as_ref().unwrap().id;
        let previous = h.time;
        h.time.elapsed_ms += if kind == "gap" { 60 * MINUTE } else { 1_000 };
        h.time.utc_ms += 1_000;
        if kind == "reverse" {
            h.time.elapsed_ms = previous.elapsed_ms - 1;
        }
        h.sequence += 1;
        let face = Face {
            sequence: h.sequence,
            detected: true,
            received_elapsed_ms: if kind == "stale_face" {
                h.time.elapsed_ms - 5_001
            } else {
                h.time.elapsed_ms
            },
            age_at_receipt_ms: 0,
        };
        let activity = Activity {
            observed_elapsed_ms: if kind == "stale_pc" {
                h.time.elapsed_ms - 5_001
            } else {
                h.time.elapsed_ms
            },
            idle_ms: Some(0),
            target: if kind == "protected" {
                Target::Restricted
            } else if kind == "unavailable" {
                Target::Unavailable
            } else {
                target("editor")
            },
        };
        h.events.extend(
            h.engine
                .tick(
                    h.time,
                    if kind == "missing" { None } else { Some(&face) },
                    Some(&activity),
                    PresenceReason::SensorUnavailable,
                )
                .unwrap(),
        );
        assert_eq!(h.engine.presence.value, Presence::Unknown, "{kind}");
        assert!(h.engine.visible_reminder().is_none());
        assert_eq!(
            h.engine.session.as_ref().unwrap().end_reason,
            Some(EndReason::Interrupted)
        );
        assert_eq!(h.reports(), 0);
        if kind == "gap" {
            assert_eq!(
                h.engine
                    .session
                    .as_ref()
                    .unwrap()
                    .ended_at
                    .unwrap()
                    .elapsed_ms,
                previous.elapsed_ms
            );
        }
        h.run(5_000, true, 0);
        assert_ne!(h.engine.session.as_ref().unwrap().id, old);
        assert_eq!(h.engine.session.as_ref().unwrap().elapsed_ms, 0);
    }
}
#[test]
fn wall_clock_changes_do_not_advance_the_sitting_timer_and_stop_is_idempotent() {
    let mut h = Harness::new(Timings::NORMAL);
    h.stable();
    h.time.utc_ms += 5 * 60 * MINUTE;
    h.run(1_000, true, 0);
    assert_eq!(h.engine.session.as_ref().unwrap().elapsed_ms, 1_000);
    assert!(h.engine.visible_reminder().is_none());
    assert_eq!(h.engine.stop(h.time).len(), 1);
    assert!(h.engine.stop(h.time).is_empty());
    assert_eq!(
        h.engine.session.as_ref().unwrap().end_reason,
        Some(EndReason::Stopped)
    );
    assert!(h.engine.visible_reminder().is_none());
}
#[test]
fn demo_uses_five_second_absence_and_normal_presence_vote_and_freshness_rules() {
    let mut h = Harness::new(Timings::DEMO);
    h.stable();
    h.until(35_000);
    assert!(h.engine.visible_reminder().is_some());
    h.answer(Answer::No);
    h.run(10_000, true, 0);
    assert!(h.engine.visible_reminder().is_some());
    h.step(1_000, false, 5_000);
    h.run(4_999, false, 5_000);
    assert_eq!(h.engine.presence.value, Presence::Uncertain);
    h.step(1, false, 5_000);
    assert_eq!(h.engine.presence.value, Presence::Away);
    assert_eq!(h.reports(), 1);
}
#[test]
fn boundary_uses_window_and_process_identity_and_emits_once_per_idle_episode() {
    let mut policy = BoundaryPolicy::default();
    let mut activity = Activity {
        observed_elapsed_ms: 0,
        idle_ms: Some(0),
        target: target("a"),
    };
    assert_eq!(policy.update(&activity, Timings::NORMAL), None);
    activity.observed_elapsed_ms = 1_000;
    activity.target = target("b");
    assert_eq!(policy.update(&activity, Timings::NORMAL), None);
    activity.observed_elapsed_ms = 3_000;
    activity.idle_ms = Some(2_000);
    assert_eq!(
        policy.update(&activity, Timings::NORMAL),
        Some(BoundaryKind::WindowSwitchIdle)
    );
    activity.observed_elapsed_ms = 6_000;
    activity.idle_ms = Some(5_000);
    assert_eq!(policy.update(&activity, Timings::NORMAL), None);
    activity.observed_elapsed_ms = 7_000;
    activity.idle_ms = Some(0);
    policy.update(&activity, Timings::NORMAL);
    activity.observed_elapsed_ms = 8_000;
    activity.target = target("c");
    policy.update(&activity, Timings::NORMAL);
    activity.observed_elapsed_ms = 18_001;
    activity.idle_ms = Some(2_000);
    assert_eq!(policy.update(&activity, Timings::NORMAL), None);
    activity.observed_elapsed_ms = 21_001;
    activity.idle_ms = Some(5_000);
    assert_eq!(
        policy.update(&activity, Timings::NORMAL),
        Some(BoundaryKind::Idle)
    );
    activity.observed_elapsed_ms += 1_000;
    activity.idle_ms = Some(0);
    policy.update(&activity, Timings::NORMAL);
    activity.observed_elapsed_ms += 1_000;
    activity.target = Target::External(WindowKey {
        process_id: 2,
        window_id: "c".into(),
    });
    policy.update(&activity, Timings::NORMAL);
    activity.observed_elapsed_ms += 2_000;
    activity.idle_ms = Some(2_000);
    assert_eq!(
        policy.update(&activity, Timings::NORMAL),
        Some(BoundaryKind::WindowSwitchIdle)
    );
}
#[test]
fn pet_excluded_protected_and_unavailable_do_not_create_or_replay_boundaries() {
    for ignored in [
        Target::Pet,
        Target::Excluded,
        Target::Restricted,
        Target::Unavailable,
    ] {
        let mut policy = BoundaryPolicy::default();
        let mut activity = Activity {
            observed_elapsed_ms: 0,
            idle_ms: Some(0),
            target: target("a"),
        };
        policy.update(&activity, Timings::NORMAL);
        activity.observed_elapsed_ms = 1_000;
        activity.target = ignored;
        activity.idle_ms = Some(1_000);
        assert_eq!(policy.update(&activity, Timings::NORMAL), None);
        activity.observed_elapsed_ms = 6_000;
        activity.target = target("b");
        activity.idle_ms = Some(6_000);
        assert_eq!(policy.update(&activity, Timings::NORMAL), None);
        activity.observed_elapsed_ms = 7_000;
        activity.idle_ms = Some(0);
        policy.update(&activity, Timings::NORMAL);
        activity.observed_elapsed_ms = 12_000;
        activity.idle_ms = Some(5_000);
        assert_eq!(
            policy.update(&activity, Timings::NORMAL),
            Some(BoundaryKind::Idle)
        );
        assert_eq!(policy.update(&activity, Timings::NORMAL), None);
    }
}
#[test]
fn exhausted_ids_do_not_partially_commit_a_domain_transition() {
    let mut h = Harness::new(Timings::NORMAL);
    for _ in 0..4 {
        h.step(1_000, true, 0);
    }
    h.engine.session_serial = u64::MAX;
    let now = Time {
        utc_ms: h.time.utc_ms + 1_000,
        elapsed_ms: h.time.elapsed_ms + 1_000,
    };
    let face = Face {
        sequence: 5,
        detected: true,
        received_elapsed_ms: now.elapsed_ms,
        age_at_receipt_ms: 0,
    };
    let activity = Activity {
        observed_elapsed_ms: now.elapsed_ms,
        idle_ms: Some(0),
        target: target("editor"),
    };
    assert_eq!(
        h.engine.tick(
            now,
            Some(&face),
            Some(&activity),
            PresenceReason::SensorUnavailable
        ),
        Err(DomainError::Exhausted)
    );
    assert!(h.engine.session.is_none());
    assert_eq!(h.engine.presence.value, Presence::Uncertain);
}
