//! 固定入力と Domain のジョブを対応付ける。生成・保存そのものはワーカーへ渡す。
use crate::{
    domain::{
        self as d,
        report::{Queue, Status},
    },
    ipc::dto::*,
};
use std::collections::HashMap;

#[derive(Clone)]
pub struct Input {
    pub history: HistorySnapshot,
    pub settings: SettingsView,
    pub consent: Consent,
    pub mode: ReportMode,
    pub secret_id: Option<Id>,
    pub created_at: Option<SafeInt>,
}
#[derive(Default)]
pub struct ReportCoordinator {
    pub queue: Queue,
    pub inputs: HashMap<String, Input>,
}
impl ReportCoordinator {
    pub fn register(
        &mut self,
        id: Id,
        input: Input,
        trigger: d::ReportTrigger,
        now: d::Time,
        delay: u64,
        generation: u64,
    ) -> Id {
        let job = self.queue.register(
            id.as_str().into(),
            input.history.session_id.as_str().into(),
            trigger,
            now,
            delay,
            generation,
        );
        let id = Id::try_from(job.id.clone()).expect("id from validated wire");
        self.inputs.entry(id.as_str().into()).or_insert(input);
        id
    }
    pub fn views(&self) -> Vec<ReportJobView> {
        self.queue
            .jobs
            .iter()
            .map(|job| ReportJobView {
                id: Id::try_from(job.id.clone()).unwrap(),
                session_id: Id::try_from(job.session_id.clone()).unwrap(),
                trigger: match job.trigger {
                    d::ReportTrigger::Yes => ReportTrigger::Yes,
                    d::ReportTrigger::Away => ReportTrigger::Away,
                },
                requested_at: number(job.requested_at.utc_ms),
                due_at: number(job.due_at.utc_ms),
                status: match job.status {
                    Status::Scheduled => JobStatus::Scheduled,
                    Status::Queued => JobStatus::Queued,
                    Status::Running => JobStatus::Running,
                    Status::Ready => JobStatus::Ready,
                    Status::Failed => JobStatus::Failed,
                    Status::Cancelled => JobStatus::Cancelled,
                },
                attempt: number(job.attempt),
                completion_seq: job.completion_seq.map(number),
            })
            .collect()
    }
    pub fn compact(&mut self, current: Option<&str>) {
        self.queue.compact(current);
        self.inputs
            .retain(|id, _| self.queue.jobs.iter().any(|job| job.id == *id));
    }
}
fn number(value: u64) -> SafeInt {
    SafeInt::try_from(value.min(MAX_SAFE_INTEGER)).unwrap()
}
pub fn local_report(job: &d::report::Job, input: &Input, now: u64) -> Report {
    Report {
        id: Id::try_from(job.id.clone()).unwrap(),
        session_id: input.history.session_id.clone(),
        trigger: match job.trigger {
            d::ReportTrigger::Yes => ReportTrigger::Yes,
            d::ReportTrigger::Away => ReportTrigger::Away,
        },
        created_at: input.created_at.unwrap_or(number(now)),
        updated_at: number(now.max(input.created_at.map_or(0, |at| at.get()))),
        attempt: number(job.attempt),
        status: ReportStatus::Local,
        history: input.history.clone(),
        content: None,
        error: None,
    }
}
