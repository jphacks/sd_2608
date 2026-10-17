//! 一度だけ作るワーカーを開始・停止で再利用する。OS 呼び出し中も Stop を妨げない。
use crate::ports::{activity::*, clock::Clock};
use std::{
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::Duration,
};

#[derive(Clone)]
struct Run {
    generation: u64,
    excluded_apps: Vec<String>,
}
#[derive(Default)]
struct Control {
    active: Option<Run>,
    shutdown: bool,
}
#[derive(Default)]
struct Shared {
    control: Mutex<Control>,
    wake: Condvar,
}
pub type ActivitySink = Arc<dyn Fn(u64, Result<ActivitySample, ActivityError>) + Send + Sync>;

pub struct ActivityMonitor {
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    source: Arc<dyn ActivitySource>,
    clock: Arc<dyn Clock>,
    sink: ActivitySink,
}
impl ActivityMonitor {
    pub fn new(source: Arc<dyn ActivitySource>, clock: Arc<dyn Clock>, sink: ActivitySink) -> Self {
        Self {
            shared: Arc::default(),
            thread: Mutex::default(),
            source,
            clock,
            sink,
        }
    }
    pub fn start(&self, generation: u64, excluded_apps: Vec<String>) -> Result<(), ActivityError> {
        let mut thread = self.thread.lock().map_err(|_| ActivityError::Unavailable)?;
        let mut control = self
            .shared
            .control
            .lock()
            .map_err(|_| ActivityError::Unavailable)?;
        if control.shutdown {
            return Err(ActivityError::Unavailable);
        }
        // 呼び出し元の世代を再度有効化しても、読み取りやタイマーを増やさない。
        if control
            .active
            .as_ref()
            .is_some_and(|run| run.generation == generation)
        {
            return Ok(());
        }
        if thread.is_none() {
            let (shared, source, clock, sink) = (
                self.shared.clone(),
                self.source.clone(),
                self.clock.clone(),
                self.sink.clone(),
            );
            *thread = Some(
                std::thread::Builder::new()
                    .name("pc-activity".into())
                    .spawn(move || worker(shared, source, clock, sink))
                    .map_err(|_| ActivityError::Unavailable)?,
            );
        }
        control.active = Some(Run {
            generation,
            excluded_apps,
        });
        self.shared.wake.notify_all();
        Ok(())
    }
    pub fn stop(&self) {
        if let Ok(mut control) = self.shared.control.lock() {
            control.active = None;
            self.shared.wake.notify_all();
        }
    }
}
impl Drop for ActivityMonitor {
    fn drop(&mut self) {
        if let Ok(mut control) = self.shared.control.lock() {
            control.shutdown = true;
            control.active = None;
            self.shared.wake.notify_all();
        }
        // OS 呼び出しの終了を UI スレッドで待たない。戻った結果は shutdown/世代で捨てる。
        // 再開始時は同じワーカーなので、遅い取得中にも二本目を作らない。
    }
}
fn worker(
    shared: Arc<Shared>,
    source: Arc<dyn ActivitySource>,
    clock: Arc<dyn Clock>,
    sink: ActivitySink,
) {
    loop {
        let run = {
            let Ok(control) = shared.control.lock() else {
                return;
            };
            let Ok(control) = shared
                .wake
                .wait_while(control, |c| !c.shutdown && c.active.is_none())
            else {
                return;
            };
            if control.shutdown {
                return;
            }
            control.active.clone().expect("active run")
        };
        let began = clock.read();
        let reading = source.read(&run.excluded_apps);
        let completed = clock.read();
        let result = if completed
            .elapsed_ms
            .checked_sub(began.elapsed_ms)
            .is_none_or(|age| age > MAX_SAMPLE_AGE_MS)
        {
            Err(ActivityError::Stale)
        } else {
            reading.map(|reading| ActivitySample {
                observed_at_ms: began.utc_ms,
                elapsed_ms: began.elapsed_ms,
                reading,
            })
        };
        let current = {
            let Ok(control) = shared.control.lock() else {
                return;
            };
            !control.shutdown
                && control
                    .active
                    .as_ref()
                    .is_some_and(|r| r.generation == run.generation)
        };
        // sink 自身も AppService のロック下で世代を再確認する。ここでは OS/状態ロックを持たない。
        if current {
            sink(run.generation, result);
        }
        let Ok(control) = shared.control.lock() else {
            return;
        };
        if shared
            .wake
            .wait_timeout_while(control, Duration::from_secs(1), |c| {
                !c.shutdown
                    && c.active
                        .as_ref()
                        .is_some_and(|r| r.generation == run.generation)
            })
            .is_err()
        {
            return;
        }
    }
}

#[cfg(test)]
mod tests;
