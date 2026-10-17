//! セッション単位の一意性・期限・優先順・試行を管理する。I/O や Wire 型には依存しない。
use super::{ReportTrigger, Time};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Scheduled,
    Queued,
    Running,
    Ready,
    Failed,
    Cancelled,
}
impl Status {
    pub fn pending(self) -> bool {
        matches!(self, Self::Scheduled | Self::Queued | Self::Running)
    }
}
#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub session_id: String,
    pub trigger: ReportTrigger,
    pub requested_at: Time,
    pub due_at: Time,
    pub generation: u64,
    pub attempt: u64,
    pub status: Status,
    pub completion_seq: Option<u64>,
    pub immediate: bool,
}
#[derive(Default)]
pub struct Queue {
    pub jobs: Vec<Job>,
    pub completion_seq: u64,
}
impl Queue {
    pub fn for_session(&self, session: &str) -> Option<&Job> {
        self.jobs.iter().find(|job| job.session_id == session)
    }
    pub fn register(
        &mut self,
        id: String,
        session: String,
        trigger: ReportTrigger,
        now: Time,
        delay: u64,
        generation: u64,
    ) -> &Job {
        if let Some(index) = self.jobs.iter().position(|job| job.session_id == session) {
            return &self.jobs[index];
        }
        let due_at = Time {
            utc_ms: now.utc_ms.saturating_add(delay),
            elapsed_ms: now.elapsed_ms.saturating_add(delay),
        };
        self.jobs.push(Job {
            id,
            session_id: session,
            trigger,
            requested_at: now,
            due_at,
            generation,
            attempt: 1,
            status: if delay == 0 {
                Status::Queued
            } else {
                Status::Scheduled
            },
            completion_seq: None,
            immediate: delay == 0,
        });
        self.jobs.last().unwrap()
    }
    pub fn take(&mut self, now: Time) -> Option<Job> {
        if self.jobs.iter().any(|job| job.status == Status::Running) {
            return None;
        }
        for job in &mut self.jobs {
            if job.status == Status::Scheduled && now.elapsed_ms >= job.due_at.elapsed_ms {
                job.status = Status::Queued;
            }
        }
        let index = self
            .jobs
            .iter()
            .enumerate()
            .filter(|(_, job)| job.status == Status::Queued)
            .min_by_key(|(index, job)| (!job.immediate, job.due_at.elapsed_ms, *index))
            .map(|(index, _)| index)?;
        self.jobs[index].status = Status::Running;
        Some(self.jobs[index].clone())
    }
    pub fn finish(&mut self, id: &str, generation: u64, attempt: u64, failed: bool) -> bool {
        let Some(job) = self.jobs.iter_mut().find(|job| {
            job.id == id
                && job.generation == generation
                && job.attempt == attempt
                && job.status == Status::Running
        }) else {
            return false;
        };
        let Some(sequence) = self.completion_seq.checked_add(1) else {
            return false;
        };
        self.completion_seq = sequence;
        job.completion_seq = Some(sequence);
        job.status = if failed {
            Status::Failed
        } else {
            Status::Ready
        };
        true
    }
    pub fn retry(&mut self, id: &str, attempt: u64, now: Time, generation: u64) -> bool {
        let Some(job) = self
            .jobs
            .iter_mut()
            .find(|job| job.id == id && job.attempt == attempt && job.status == Status::Failed)
        else {
            return false;
        };
        let Some(attempt) = attempt.checked_add(1) else {
            return false;
        };
        job.attempt = attempt;
        job.generation = generation;
        job.due_at = now;
        job.immediate = true;
        job.status = Status::Queued;
        job.completion_seq = None;
        true
    }
    pub fn cancel(&mut self) {
        for job in &mut self.jobs {
            if job.status.pending() {
                job.status = Status::Cancelled;
            }
        }
    }
    /// 終了済みジョブだけを整理。現在のセッションと全予約は保持する。
    pub fn compact(&mut self, current: Option<&str>) {
        let mut remaining = 20;
        self.jobs.reverse();
        self.jobs.retain(|job| {
            if job.status.pending() || Some(job.session_id.as_str()) == current {
                return true;
            }
            if remaining > 0 {
                remaining -= 1;
                true
            } else {
                false
            }
        });
        self.jobs.reverse();
    }
}
