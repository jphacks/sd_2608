use crate::{
    application::privacy::{mask, mask_ocr},
    ipc::dto::*,
    ports::ocr::OcrBatch,
};
use std::{
    collections::hash_map::RandomState,
    hash::{BuildHasher, Hash, Hasher},
};
pub const MAX_OCR_CHARS: usize = 24_000;
pub fn window_ref(salt: &RandomState, key: &crate::domain::WindowKey) -> Id {
    let mut hash = salt.build_hasher();
    key.hash(&mut hash);
    Id::try_from(format!("window-{:016x}", hash.finish())).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::WindowKey,
        ports::ocr::{OcrBatch, OcrWindow},
    };
    #[test]
    fn history_identity_selects_used_windows_and_masks_text_before_export() {
        let salt = RandomState::new();
        let key = WindowKey {
            process_id: 5,
            window_id: "private-handle".into(),
        };
        let mut history: HistorySnapshot = serde_json::from_value(serde_json::json!({"id":"h","sessionId":"s","capturedAt":1000,"rangeStart":0,"rangeEnd":1000,
            "segments":[{"id":"seg","sessionId":"s","startedAt":0,"endedAt":1000,"appName":"editor.exe","maskedTitle":"same title"}]})).unwrap();
        history.segments[0].window_ref = Some(window_ref(&salt, &key));
        let used = OcrWindow {
            key: key.clone(),
            app_name: "EDITOR.EXE".into(),
            title: "changed title".into(),
            text: "work notes mail@example.test api_key=private-value https://private.test".into(),
        };
        let unused = OcrWindow {
            key: WindowKey {
                window_id: "different-window".into(),
                ..key
            },
            app_name: "editor.exe".into(),
            title: "same title".into(),
            text: "unrelated private text".into(),
        };
        let result = context(
            Ok(OcrBatch {
                windows: vec![used, unused],
                unavailable: 2,
            }),
            &history,
            2000,
            &salt,
        );
        assert_eq!(result.windows.len(), 1);
        assert_eq!(result.unmatched_windows.get(), 1);
        assert_eq!(result.unavailable_windows.get(), 2);
        let json = serde_json::to_string(&result).unwrap();
        for private in [
            "private-handle",
            "private-value",
            "private.test",
            "mail@example.test",
            "unrelated",
        ] {
            assert!(!json.contains(private));
        }
        assert!(json.contains("work notes"));
    }
    #[test]
    fn unavailable_ocr_remains_an_explicit_empty_context() {
        let history: HistorySnapshot = serde_json::from_value(serde_json::json!({"id":"h","sessionId":"s","capturedAt":1000,"rangeStart":0,"rangeEnd":1000,"segments":[]})).unwrap();
        let result = context(Err(()), &history, 2000, &RandomState::new());
        assert!(result.windows.is_empty());
        assert_eq!(result.unavailable_windows.get(), 1);
    }
}
pub fn context(
    batch: Result<OcrBatch, ()>,
    history: &HistorySnapshot,
    at: u64,
    salt: &RandomState,
) -> OcrContext {
    let Ok(batch) = batch else {
        return OcrContext {
            captured_at: SafeInt::try_from(at.min(MAX_SAFE_INTEGER)).unwrap(),
            windows: vec![],
            unavailable_windows: SafeInt::try_from(1).unwrap(),
            unmatched_windows: SafeInt::ZERO,
        };
    };
    let mut windows = vec![];
    let mut unmatched = 0;
    let mut budget = MAX_OCR_CHARS;
    let mut unavailable = batch.unavailable;
    for window in batch.windows {
        let app_name = mask(&window.app_name);
        let masked_title = mask(&window.title);
        // PID/HWND を外へ出さず、同じアプリ・同じタイトルの別ウィンドウも区別する。
        let reference = window_ref(salt, &window.key);
        if !history.segments.iter().any(|s| {
            s.window_ref.as_ref() == Some(&reference) && s.app_name.eq_ignore_ascii_case(&app_name)
        }) {
            unmatched += 1;
            continue;
        }
        if budget == 0 || windows.len() >= 128 {
            unavailable += 1;
            continue;
        }
        let text: String = mask_ocr(&window.text).chars().take(budget).collect();
        if text.is_empty() {
            continue;
        }
        budget -= text.chars().count();
        windows.push(WindowOcr {
            app_name,
            masked_title,
            text,
        });
    }
    OcrContext {
        captured_at: SafeInt::try_from(at.min(MAX_SAFE_INTEGER)).unwrap(),
        windows,
        unavailable_windows: SafeInt::try_from(unavailable as u64).unwrap_or(SafeInt::ZERO),
        unmatched_windows: SafeInt::try_from(unmatched).unwrap(),
    }
}
