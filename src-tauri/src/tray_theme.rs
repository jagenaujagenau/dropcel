//! macOS-only: repaint the tray icon when the menubar flips between light and
//! dark. Idle/ready icons are templates, which macOS recolors on its own, but
//! the deploying/failed icons carry a colored dot — they ship their own white
//! or black triangle, so they go stale on an appearance change until the next
//! status update. AppKit announces the switch through the distributed
//! notification center; we observe it and re-render the current status.
//!
//! Best-effort, like `tray_drop`: if registration fails the icon simply keeps
//! its old color until the next `update_tray`.
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{
    NSDistributedNotificationCenter, NSNotification, NSObject, NSObjectProtocol, NSString,
};
use tauri::AppHandle;

const THEME_CHANGED: &str = "AppleInterfaceThemeChangedNotification";

static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VFTrayThemeObserver"]
    struct ThemeObserver;

    unsafe impl NSObjectProtocol for ThemeObserver {}

    impl ThemeObserver {
        #[unsafe(method(appearanceChanged:))]
        fn appearance_changed(&self, _note: &NSNotification) {
            if let Some(app) = APP.get() {
                crate::tray::refresh_icon(app);
            }
        }
    }
);

pub fn attach(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        crate::logger::log(app, "warn", "tray-theme", "not on main thread, skipping");
        return;
    };
    let observer: Retained<ThemeObserver> = unsafe { msg_send![ThemeObserver::alloc(mtm), init] };
    unsafe {
        NSDistributedNotificationCenter::defaultCenter().addObserver_selector_name_object(
            &observer,
            objc2::sel!(appearanceChanged:),
            Some(&NSString::from_str(THEME_CHANGED)),
            None,
        );
    }
    // The notification center holds observers unretained, so the observer has
    // to outlive this scope — it lives as long as the tray, i.e. the process.
    let _ = Retained::into_raw(observer);
}
