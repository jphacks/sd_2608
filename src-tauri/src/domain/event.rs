use super::{Boundary, Session, Time};
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ReportTrigger {
    Yes,
    Away,
}
#[derive(Clone, Debug, PartialEq)]
pub enum DomainEvent {
    BoundaryDetected(Boundary),
    SessionStarted(Session),
    SessionEnded {
        session: Session,
        detected_at: Time,
    },
    ReportRequested {
        session: Session,
        trigger: ReportTrigger,
        requested_at: Time,
    },
}
