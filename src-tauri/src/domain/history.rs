//! マスク済み入力だけを受け取る、現在セッションの有界な履歴。
use super::{Time, WindowKey};
use std::collections::VecDeque;

pub const RETENTION_MS: u64 = 30 * 60 * 1_000;
pub const MAX_SEGMENTS: usize = 600;
pub const SAMPLE_GAP_MS: u64 = 5_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MaskedWindow {
    pub key: WindowKey,
    pub title_fingerprint: u64,
    pub app_name: String,
    pub title: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub serial: u64,
    pub start: u64,
    pub end: u64,
    pub app_name: String,
    pub title: String,
    identity: MaskedWindow,
}
impl Segment {
    pub fn window_key(&self) -> &WindowKey {
        &self.identity.key
    }
}
#[derive(Default)]
pub struct History {
    pub session_id: Option<u64>,
    pub started_at: Option<Time>,
    segments: VecDeque<Segment>,
    last: Option<(u64, Option<MaskedWindow>)>,
    serial: u64,
    ended_at: Option<u64>,
}
impl History {
    pub fn begin(&mut self, session_id: u64, start: Time) {
        *self = Self {
            session_id: Some(session_id),
            started_at: Some(start),
            ..Self::default()
        };
    }
    /// 同じサンプルを UI のポーリングで水増ししない。入力間の空白は最大5秒。
    pub fn record(&mut self, at: u64, target: Option<MaskedWindow>) {
        if self.ended_at.is_some() || self.started_at.is_none_or(|start| at < start.elapsed_ms) {
            return;
        }
        if let Some((last_at, previous)) = self.last.take() {
            if at <= last_at {
                self.last = Some((last_at, previous));
                return;
            }
            if at - last_at <= SAMPLE_GAP_MS {
                if let Some(ref window) = previous {
                    self.append(last_at, at, window);
                }
            }
        }
        self.last = Some((at, target));
        self.trim(at);
    }
    fn append(&mut self, start: u64, end: u64, window: &MaskedWindow) {
        // 直前の同一 target のみ結合。除外・欠測をまたいで結合しない。
        if let Some(segment) = self.segments.back_mut() {
            if segment.end == start && segment.identity == *window {
                segment.end = end;
                return;
            }
        }
        self.serial += 1;
        self.segments.push_back(Segment {
            serial: self.serial,
            start,
            end,
            app_name: window.app_name.clone(),
            title: window.title.clone(),
            identity: window.clone(),
        });
    }
    fn trim(&mut self, at: u64) {
        let floor = at.saturating_sub(RETENTION_MS);
        self.segments.retain(|segment| segment.end > floor);
        if let Some(first) = self.segments.front_mut() {
            first.start = first.start.max(floor);
        }
        while self.segments.len() > MAX_SEGMENTS {
            self.segments.pop_front();
        }
    }
    pub fn end(&mut self, at: u64) {
        self.ended_at = Some(at);
        self.segments.retain(|segment| segment.start < at);
        for segment in &mut self.segments {
            segment.end = segment.end.min(at);
        }
    }
    /// 取得後の追加・切詰めから独立したコピー。終了後は終了時刻まで。
    pub fn freeze(&self, session_id: u64, end: u64) -> Option<(u64, u64, Vec<Segment>)> {
        if self.session_id != Some(session_id) {
            return None;
        }
        let start = self.started_at?;
        let end = end.min(self.ended_at.unwrap_or(end)).max(start.elapsed_ms);
        let floor = end.saturating_sub(RETENTION_MS).max(start.elapsed_ms);
        let mut segments: Vec<Segment> = self
            .segments
            .iter()
            .filter_map(|segment| {
                let mut segment = segment.clone();
                segment.start = segment.start.max(floor);
                segment.end = segment.end.min(end);
                (segment.start < segment.end).then_some(segment)
            })
            .collect();
        if let Some((at, Some(window))) = &self.last {
            let tail_end = end.min(at.saturating_add(SAMPLE_GAP_MS));
            let tail_start = (*at).max(floor);
            if tail_start < tail_end {
                if let Some(last) = segments
                    .last_mut()
                    .filter(|last| last.end == tail_start && last.identity == *window)
                {
                    last.end = tail_end;
                } else {
                    segments.push(Segment {
                        serial: self.serial + 1,
                        start: tail_start,
                        end: tail_end,
                        app_name: window.app_name.clone(),
                        title: window.title.clone(),
                        identity: window.clone(),
                    });
                }
            }
        }
        if segments.len() > MAX_SEGMENTS {
            segments.drain(..segments.len() - MAX_SEGMENTS);
        }
        Some((floor, end, segments))
    }
}
