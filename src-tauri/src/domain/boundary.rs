use super::{Activity, BoundaryKind, Target, WindowKey, timings::Timings};

#[derive(Clone)]
pub struct BoundaryPolicy {
    last_sample: Option<u64>,
    previous: Option<WindowKey>,
    switched_at: Option<u64>,
    last_idle: Option<u64>,
    emitted: bool,
}
impl Default for BoundaryPolicy {
    fn default() -> Self {
        Self {
            last_sample: None,
            previous: None,
            switched_at: None,
            last_idle: None,
            emitted: false,
        }
    }
}
impl BoundaryPolicy {
    pub fn invalidate(&mut self) {
        self.previous = None;
        self.switched_at = None;
        self.emitted = true;
    }
    pub fn update(&mut self, activity: &Activity, timings: Timings) -> Option<BoundaryKind> {
        if self.last_sample == Some(activity.observed_elapsed_ms) {
            return None;
        }
        self.last_sample = Some(activity.observed_elapsed_ms);
        let Target::External(window) = &activity.target else {
            self.invalidate();
            self.last_idle = activity.idle_ms;
            return None;
        };
        let Some(idle) = activity.idle_ms else {
            self.invalidate();
            return None;
        };
        if idle == 0 || self.last_idle.is_some_and(|last| idle < last) {
            self.emitted = false;
        }
        if self
            .previous
            .as_ref()
            .is_some_and(|previous| previous != window)
        {
            self.switched_at = Some(activity.observed_elapsed_ms);
        }
        self.previous = Some(window.clone());
        self.last_idle = Some(idle);
        if self.emitted {
            return None;
        }
        let kind = if self.switched_at.is_some_and(|at| {
            activity.observed_elapsed_ms.saturating_sub(at) <= timings.switch_window_ms
        }) && idle >= timings.switch_idle_ms
        {
            Some(BoundaryKind::WindowSwitchIdle)
        } else if idle >= timings.idle_ms {
            Some(BoundaryKind::Idle)
        } else {
            None
        };
        if kind.is_some() {
            self.emitted = true;
        }
        kind
    }
}
