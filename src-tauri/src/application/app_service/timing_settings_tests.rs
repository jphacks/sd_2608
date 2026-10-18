use super::*;
use super::{sitting_tests::Rig, tests::snapshot};

fn n(value: u64) -> SafeInt {
    SafeInt::try_from(value).unwrap()
}

fn configured(profile: TimingProfile) -> Rig {
    let rig = Rig::new();
    rig.service.state.lock().unwrap().snapshot.runtime.phase = RuntimePhase::Stopped;
    let mut values = rig.service.persistence.lock().unwrap().settings_view();
    for (timings, first, limit, hard) in [
        (&mut values.timings.normal, 12_000, 16_000, 60_000),
        (&mut values.timings.demo, 8_000, 10_000, 40_000),
    ] {
        timings.first_ms = n(first);
        timings.first_limit_ms = n(limit);
        timings.hard_ms = n(hard);
        timings.advance_notice_lead_ms = n(2_000);
        timings.snooze_ms = n(7_000);
        timings.cooldown_ms = n(3_000);
        timings.hard_repeat_ms = n(4_000);
        timings.yes_grace_ms = n(5_000);
        timings.absence_ms = n(2_000);
        timings.report_delay_ms = n(9_000);
        timings.idle_ms = n(3_000);
        timings.switch_window_ms = n(4_000);
        timings.switch_idle_ms = n(2_000);
    }
    let mut input = serde_json::to_value(values).unwrap();
    input.as_object_mut().unwrap().remove("revision");
    input.as_object_mut().unwrap().remove("hasApiKey");
    assert!(matches!(rig.service.dispatch("main", Command::SettingsUpdate, Some(json!({
        "requestId":"custom-timings", "expectedSettingsRevision":0, "values":input, "keyChange":{"kind":"keep"}
    }))).result, ApiResult::Success(_)));
    assert!(matches!(rig.service.dispatch("main", Command::RuntimeStart, Some(json!({
        "requestId":"custom-start", "profile":profile, "expectedSettingsRevision":1, "reportMode":"local",
        "consent":{"activity":true,"history":true,"externalReport":false}
    }))).result, ApiResult::Success(_)));
    // 以後は Rig の手動時計と正規化済み入力だけで時間を進める。
    rig.service.monitor.stop();
    rig
}

#[test]
fn saved_profile_controls_notice_limits_snooze_grace_and_hard_repeat_after_start() {
    for profile in [TimingProfile::Normal, TimingProfile::Demo] {
        let mut rig = configured(profile);
        let times = snapshot(&rig.service).settings.timings.for_profile(profile);
        rig.stable();
        rig.run(
            (times.first_ms - times.advance_notice_lead_ms) / 1_000 - 1,
            true,
            0,
        );
        assert!(snapshot(&rig.service).advance_notice.is_none());
        rig.run(1, true, 0);
        assert_eq!(
            snapshot(&rig.service)
                .advance_notice
                .unwrap()
                .remaining_ms
                .get(),
            2_000
        );
        rig.run(
            (times.first_limit_ms - times.first_ms + times.advance_notice_lead_ms) / 1_000 - 1,
            true,
            0,
        );
        assert!(snapshot(&rig.service).reminder.is_none());
        rig.run(1, true, 0);
        assert_eq!(
            snapshot(&rig.service).reminder.unwrap().cause,
            ReminderCause::InitialLimit
        );
        assert!(matches!(
            rig.answer(rig.answer_request("no", "no")).result,
            ApiResult::Success(_)
        ));
        rig.run(6, true, 0);
        assert!(snapshot(&rig.service).reminder.is_none());
        rig.run(1, true, 0);
        assert_eq!(
            snapshot(&rig.service).reminder.unwrap().cause,
            ReminderCause::SnoozeLimit
        );
        assert!(matches!(
            rig.answer(rig.answer_request("yes", "yes")).result,
            ApiResult::Success(_)
        ));
        rig.run(4, true, 0);
        assert!(snapshot(&rig.service).reminder.is_none());
        rig.run(1, true, 0);
        assert!(snapshot(&rig.service).reminder.is_some());
        let elapsed = snapshot(&rig.service).session.unwrap().elapsed_ms.get();
        rig.run((times.hard_ms - elapsed) / 1_000, true, 0);
        assert_eq!(
            snapshot(&rig.service).reminder.unwrap().level,
            ReminderLevel::Hard
        );
        assert!(matches!(
            rig.answer(rig.answer_request("hard-no", "no")).result,
            ApiResult::Success(_)
        ));
        rig.run(3, true, 0);
        assert!(snapshot(&rig.service).reminder.is_none());
        rig.run(1, true, 0);
        assert_eq!(
            snapshot(&rig.service).reminder.unwrap().cause,
            ReminderCause::HardLimit
        );
    }
}

#[test]
fn saved_absence_and_report_delay_apply_in_both_profiles() {
    for profile in [TimingProfile::Normal, TimingProfile::Demo] {
        let mut rig = configured(profile);
        rig.stable();
        rig.run(2, false, 20_000);
        assert!(snapshot(&rig.service).jobs.is_empty());
        rig.run(1, false, 20_000);
        let view = snapshot(&rig.service);
        assert_eq!(view.presence.value, Presence::Away);
        assert_eq!(view.jobs.len(), 1);
        assert_eq!(
            view.jobs[0].due_at.get() - view.jobs[0].requested_at.get(),
            9_000
        );
    }
}

#[test]
fn saved_boundary_threshold_and_cooldown_are_used() {
    let mut rig = configured(TimingProfile::Demo);
    rig.stable();
    rig.run(8, true, 0);
    rig.step(1_000, true, 2_000);
    assert!(snapshot(&rig.service).reminder.is_none());
    rig.step(1_000, true, 3_000);
    assert_eq!(
        snapshot(&rig.service).reminder.unwrap().cause,
        ReminderCause::Boundary
    );
    assert!(matches!(
        rig.answer(rig.answer_request("boundary-no", "no")).result,
        ApiResult::Success(_)
    ));
    rig.step(1_000, true, 0);
    rig.step(1_000, true, 3_000);
    assert!(snapshot(&rig.service).reminder.is_none());
    rig.step(1_000, true, 0);
    rig.step(1_000, true, 3_000);
    assert_eq!(
        snapshot(&rig.service).reminder.unwrap().cause,
        ReminderCause::Boundary
    );
}
