//! クリック透過中の押下も通知する。入力を遮らず、履歴には保存しない。
use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
};
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::{
        LibraryLoader::GetModuleHandleW,
        Threading::{GetCurrentProcessId, GetCurrentThreadId},
    },
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GA_ROOTOWNER, GetAncestor, GetMessageW,
        GetWindowThreadProcessId, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE, PeekMessageW,
        PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN, WM_XBUTTONDOWN, WindowFromPoint,
    },
};

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PointerDown {
    x: i32,
    y: i32,
    target_is_app: bool,
}

thread_local! {
    static CLICKS: RefCell<Option<SyncSender<PointerDown>>> = const { RefCell::new(None) };
}

fn is_button_down(code: i32, message: u32) -> bool {
    code >= 0
        && matches!(
            message,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        )
}

unsafe extern "system" fn pointer_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if is_button_down(code, wparam.0 as u32) {
        // WH_MOUSE_LL の押下時だけ lParam は有効な MSLLHOOKSTRUCT を指す。
        let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
        let target = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOTOWNER) };
        let mut process = 0;
        unsafe {
            GetWindowThreadProcessId(target, Some(&mut process));
        }
        let click = PointerDown {
            x: point.x,
            y: point.y,
            target_is_app: process == unsafe { GetCurrentProcessId() },
        };
        // フック内で IPC を待たない。混雑時も OS のクリック配送を妨げない。
        CLICKS.with(|sender| {
            if let Some(sender) = sender.borrow().as_ref() {
                let _ = sender.try_send(click);
            }
        });
    }
    // 必ず次のフック／背後のアプリへクリックを渡す。
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

pub struct PointerObserver {
    thread_id: Arc<AtomicU32>,
}

impl PointerObserver {
    pub fn start(on_down: impl Fn(PointerDown) + Send + 'static) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel(32);
        thread::Builder::new()
            .name("pochi-click-events".into())
            .spawn(move || {
                for click in receiver {
                    on_down(click);
                }
            })?;
        let (ready, started) = mpsc::sync_channel(1);
        let thread_id = Arc::new(AtomicU32::new(0));
        let live_thread = Arc::clone(&thread_id);
        thread::Builder::new()
            .name("pochi-click-hook".into())
            .spawn(move || {
                let installed = (|| -> windows::core::Result<_> {
                    let module = unsafe { GetModuleHandleW(None)? };
                    unsafe {
                        SetWindowsHookExW(WH_MOUSE_LL, Some(pointer_hook), Some(module.into()), 0)
                    }
                })();
                let hook = match installed {
                    Ok(hook) => hook,
                    Err(_) => {
                        let _ = ready
                            .send(Err(std::io::Error::other("クリック検出を開始できません。")));
                        return;
                    }
                };
                CLICKS.with(|slot| *slot.borrow_mut() = Some(sender));
                let mut message = MSG::default();
                // 終了通知を受け取れるよう、ready より先にメッセージキューを作る。
                unsafe {
                    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                }
                live_thread.store(unsafe { GetCurrentThreadId() }, Ordering::Release);
                if ready.send(Ok(())).is_ok() {
                    while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
                        unsafe {
                            let _ = TranslateMessage(&message);
                            DispatchMessageW(&message);
                        }
                    }
                }
                unsafe {
                    let _ = UnhookWindowsHookEx(hook);
                }
                CLICKS.with(|slot| *slot.borrow_mut() = None);
                live_thread.store(0, Ordering::Release);
            })?;
        started
            .recv()
            .map_err(|_| std::io::Error::other("クリック検出の準備に失敗しました。"))??;
        Ok(Self { thread_id })
    }

    pub fn stop(&self) {
        let id = self.thread_id.swap(0, Ordering::AcqRel);
        if id != 0 {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

impl Drop for PointerObserver {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_button_downs_are_notified_and_negative_hook_codes_are_ignored() {
        for button in [
            WM_LBUTTONDOWN,
            WM_RBUTTONDOWN,
            WM_MBUTTONDOWN,
            WM_XBUTTONDOWN,
        ] {
            assert!(is_button_down(0, button));
            assert!(!is_button_down(-1, button));
        }
        for message in [0x0200, 0x0202, 0x020A] {
            assert!(!is_button_down(0, message));
        }
    }

    #[test]
    fn event_contains_only_click_coordinates_and_app_ownership() {
        let click = PointerDown {
            x: -100,
            y: 200,
            target_is_app: false,
        };
        assert_eq!(
            serde_json::to_value(click).unwrap(),
            serde_json::json!({"x": -100, "y": 200, "targetIsApp": false})
        );
    }

    #[test]
    fn observer_stops_and_releases_callback_without_injecting_clicks() {
        struct Released(mpsc::Sender<()>);
        impl Drop for Released {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        let (sent, released) = mpsc::channel();
        let lifetime = Released(sent);
        let observer = PointerObserver::start(move |_| {
            let _ = &lifetime;
        })
        .unwrap();
        observer.stop();
        observer.stop();
        released
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(observer.thread_id.load(Ordering::Acquire), 0);
    }
}
