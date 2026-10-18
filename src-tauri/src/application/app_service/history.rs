//! センサーをマスク済み Domain 入力へ変換し、固定コピーを Wire 型へ変換する。
use super::*;
use crate::{
    application::privacy::mask,
    domain::{self as d, history::MaskedWindow},
};

pub(super) fn record(state: &mut State) {
    let Some(session) = state
        .domain
        .as_ref()
        .and_then(|engine| engine.session.as_ref())
        .filter(|session| session.ended_at.is_none())
    else {
        return;
    };
    let Some(sample) = state.activity.as_ref() else {
        return;
    };
    if sample.elapsed_ms < session.started_at.elapsed_ms {
        return;
    }
    let target = match &sample.reading.foreground {
        Foreground::External(window) => {
            let mut hash = state.fingerprinters[0].build_hasher();
            window.window_title.hash(&mut hash);
            Some(MaskedWindow {
                key: d::WindowKey {
                    process_id: window.process_id,
                    window_id: window.window_id.clone(),
                },
                title_fingerprint: hash.finish(),
                app_name: mask(&window.app_name),
                title: mask(&window.window_title),
            })
        }
        _ => None,
    };
    state.history.record(sample.elapsed_ms, target);
}
pub(super) fn checkpoint_away(state: &mut State) {
    let point = state
        .domain
        .as_ref()
        .and_then(|engine| {
            Some((
                engine.session.as_ref()?.clone(),
                engine.presence.missing_since?,
            ))
        })
        .filter(|(session, _)| session.ended_at.is_none());
    let Some((session, missing)) = point else {
        state.away_history_candidate = None;
        return;
    };
    if state
        .away_history_candidate
        .as_ref()
        .is_some_and(|(id, at, _)| *id == session.id && *at == missing.elapsed_ms)
    {
        return;
    }
    state.away_history_candidate = freeze(state, &session, missing)
        .ok()
        .map(|history| (session.id, missing.elapsed_ms, history));
}
pub(super) fn requested(
    state: &State,
    session: &d::Session,
    at: d::Time,
) -> Result<HistorySnapshot, ApiError> {
    // 確定待ち中に通常バッファが進んでも、離席開始時点の先頭30秒を落とさない。
    if let Some((id, elapsed, frozen)) = &state.away_history_candidate {
        if *id == session.id
            && session
                .ended_at
                .is_some_and(|end| end.elapsed_ms == *elapsed)
        {
            let mut frozen = frozen.clone();
            frozen.captured_at =
                SafeInt::try_from(at.utc_ms.max(frozen.range_end.get())).map_err(|_| internal())?;
            return Ok(frozen);
        }
    }
    freeze(state, session, at)
}
pub(super) fn freeze(
    state: &State,
    session: &d::Session,
    at: d::Time,
) -> Result<HistorySnapshot, ApiError> {
    let (floor, end, segments) = state
        .history
        .freeze(session.id, at.elapsed_ms)
        .ok_or_else(internal)?;
    let session_id = sitting::domain_id(state, "session", session.id)?;
    let anchored = |elapsed: u64| {
        SafeInt::try_from(
            session
                .started_at
                .utc_ms
                .saturating_add(elapsed.saturating_sub(session.started_at.elapsed_ms)),
        )
        .map_err(|_| internal())
    };
    Ok(HistorySnapshot {
        id: sitting::domain_id(state, "history", session.id)?,
        session_id: session_id.clone(),
        captured_at: SafeInt::try_from(at.utc_ms.max(anchored(end)?.get()))
            .map_err(|_| internal())?,
        range_start: anchored(floor)?,
        range_end: anchored(end)?,
        ocr: None,
        segments: segments
            .into_iter()
            .map(|segment| {
                Ok(ActivitySegment {
                    window_ref: Some(crate::application::ocr_context::window_ref(
                        &state.fingerprinters[1],
                        segment.window_key(),
                    )),
                    id: Id::try_from(format!(
                        "segment-{}-{}",
                        session_id.as_str(),
                        segment.serial
                    ))
                    .map_err(|_| internal())?,
                    session_id: session_id.clone(),
                    started_at: anchored(segment.start)?,
                    ended_at: anchored(segment.end)?,
                    app_name: segment.app_name,
                    masked_title: segment.title,
                })
            })
            .collect::<Result<_, ApiError>>()?,
    })
}
