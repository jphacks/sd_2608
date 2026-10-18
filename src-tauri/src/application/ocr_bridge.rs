//! レポートワーカーからローカル WebView の OCR へ一枚ずつ渡す。画像は保存しない。
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRequest {
    pub request_id: String,
    pub image: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replies_require_main_and_the_current_one_shot_request() {
        let bridge = Arc::new(OcrBridge::default());
        let responder = bridge.clone();
        bridge.attach(Arc::new(move |request| {
            if request.image.is_some() {
                assert!(!responder.complete(
                    "other",
                    OcrReply {
                        request_id: request.request_id.clone(),
                        text: "bad".into(),
                        failed: false
                    }
                ));
                assert!(!responder.complete(
                    "main",
                    OcrReply {
                        request_id: "stale".into(),
                        text: "bad".into(),
                        failed: false
                    }
                ));
                assert!(responder.complete(
                    "main",
                    OcrReply {
                        request_id: request.request_id.clone(),
                        text: "recognized".into(),
                        failed: false
                    }
                ));
                assert!(!responder.complete(
                    "main",
                    OcrReply {
                        request_id: request.request_id,
                        text: "duplicate".into(),
                        failed: false
                    }
                ));
            }
            true
        }));
        assert_eq!(
            bridge.recognize("test image".into(), &|| true).unwrap(),
            "recognized"
        );
        assert!(bridge.pending.lock().unwrap().is_none());
    }
    #[test]
    fn cancellation_clears_images_and_rejects_late_text() {
        let bridge = Arc::new(OcrBridge::default());
        let (tx, rx) = std::sync::mpsc::channel();
        bridge.attach(Arc::new(move |request| {
            if request.image.is_some() {
                tx.send(request.request_id).unwrap();
            }
            true
        }));
        let current = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (run, flag) = (bridge.clone(), current.clone());
        let thread = std::thread::spawn(move || {
            run.recognize("test".into(), &|| flag.load(Ordering::SeqCst))
        });
        let id = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        current.store(false, Ordering::SeqCst);
        assert!(thread.join().unwrap().is_err());
        assert!(!bridge.complete(
            "main",
            OcrReply {
                request_id: id,
                text: "late".into(),
                failed: false
            }
        ));
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrReply {
    pub request_id: String,
    pub text: String,
    pub failed: bool,
}
type Publisher = Arc<dyn Fn(OcrRequest) -> bool + Send + Sync>;
struct Pending {
    id: String,
    reply: Option<Result<String, ()>>,
}
#[derive(Default)]
pub struct OcrBridge {
    publisher: Mutex<Option<Publisher>>,
    pending: Mutex<Option<Pending>>,
    wake: Condvar,
    serial: AtomicU64,
}
impl OcrBridge {
    pub fn attach(&self, publisher: Publisher) {
        *self.publisher.lock().unwrap() = Some(publisher);
    }
    pub fn complete(&self, window: &str, reply: OcrReply) -> bool {
        if window != "main" || reply.text.len() > 131_072 {
            return false;
        }
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        let Some(pending) = pending
            .as_mut()
            .filter(|p| p.id == reply.request_id && p.reply.is_none())
        else {
            return false;
        };
        pending.reply = Some(if reply.failed {
            Err(())
        } else {
            Ok(reply.text)
        });
        self.wake.notify_all();
        true
    }
    pub fn recognize(
        &self,
        image: String,
        current: &(dyn Fn() -> bool + Sync),
    ) -> Result<String, ()> {
        if !current() {
            return Err(());
        }
        let publish = self.publisher.lock().map_err(|_| ())?.clone().ok_or(())?;
        let id = format!(
            "ocr-{}-{}",
            std::process::id(),
            self.serial.fetch_add(1, Ordering::Relaxed)
        );
        {
            let mut pending = self.pending.lock().map_err(|_| ())?;
            if pending.is_some() {
                return Err(());
            }
            *pending = Some(Pending {
                id: id.clone(),
                reply: None,
            });
        }
        let sent = publish(OcrRequest {
            request_id: id.clone(),
            image: Some(image),
        });
        let began = Instant::now();
        let mut pending = self.pending.lock().map_err(|_| ())?;
        let result = loop {
            if !sent || !current() || began.elapsed() >= Duration::from_secs(30) {
                break Err(());
            }
            if let Some(reply) = pending.as_mut().and_then(|p| p.reply.take()) {
                break reply;
            }
            pending = self
                .wake
                .wait_timeout(pending, Duration::from_millis(50))
                .map_err(|_| ())?
                .0;
        };
        *pending = None;
        drop(pending);
        // 完了時にも worker を止める。遅れて完了した旧 OCR は次の画像へ混ざらない。
        publish(OcrRequest {
            request_id: id,
            image: None,
        });
        result
    }
}
