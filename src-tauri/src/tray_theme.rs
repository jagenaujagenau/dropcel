//! macOS-only: keep the tray icon's color in step with the menubar.
//!
//! Idle/ready icons are templates, which macOS recolors itself. The deploying
//! and failed icons carry a colored dot, so they cannot be templates and have
//! to supply their own white or black triangle — which means knowing how the
//! menubar is actually drawn.
//!
//! That is *not* the same as Dark Mode: in Light Mode over a dark desktop
//! picture the menubar still renders dark and template icons still come out
//! white. The authority is the status item button's own `effectiveAppearance`,
//! which we read and observe through KVO — it changes for both a Dark Mode
//! toggle and a wallpaper swap.
//!
//! Best-effort, like `tray_drop`: if the button can't be found we fall back to
//! `AppleInterfaceStyle` plus the distributed theme notification, which catches
//! the Dark Mode case but not the wallpaper one.
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSView,
};
use objc2_foundation::{
    ns_string, NSArray, NSDictionary, NSDistributedNotificationCenter, NSKeyValueObservingOptions,
    NSNotification, NSObject, NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSString,
    NSUserDefaults,
};
use tauri::AppHandle;

const THEME_CHANGED: &str = "AppleInterfaceThemeChangedNotification";

static APP: OnceLock<AppHandle> = OnceLock::new();
/// The observed status button, kept so a repaint can re-read its appearance
/// without walking the window list again.
static BUTTON: OnceLock<ButtonHandle> = OnceLock::new();

/// `Retained<NSView>` is main-thread-only and so not `Send`; this pointer is
/// only dereferenced from AppKit main-thread callbacks.
struct ButtonHandle(*const AnyObject);
unsafe impl Send for ButtonHandle {}
unsafe impl Sync for ButtonHandle {}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "VFTrayThemeObserver"]
    struct ThemeObserver;

    unsafe impl NSObjectProtocol for ThemeObserver {}

    impl ThemeObserver {
        /// Dark Mode toggle — the fallback path when no button was found.
        #[unsafe(method(appearanceChanged:))]
        fn appearance_changed(&self, _note: &NSNotification) {
            sync();
        }

        /// The button's effectiveAppearance changed: Dark Mode or wallpaper.
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe_value(
            &self,
            _key_path: Option<&NSString>,
            _object: Option<&AnyObject>,
            _change: Option<&NSDictionary>,
            _context: *mut std::ffi::c_void,
        ) {
            sync();
        }
    }
);

/// Re-read the menubar appearance and repaint the tray if it flipped.
fn sync() {
    let Some(app) = APP.get() else { return };
    let dark = current_dark();
    if crate::tray::set_menubar_dark(dark) {
        let now = if dark { "dark" } else { "light" };
        crate::logger::log(app, "info", "tray-theme", &format!("menubar now {now}"));
        crate::tray::refresh_icon(app);
    }
}

/// Dark when the status button draws dark-aqua; with no button, fall back to
/// the system-wide Dark Mode flag.
fn current_dark() -> bool {
    let Some(handle) = BUTTON.get() else {
        return dark_mode_default();
    };
    // SAFETY: called only from `attach` and AppKit callbacks (main thread),
    // and the button is retained for the process lifetime.
    let button: &NSView = unsafe { &*handle.0.cast() };
    let appearance = button.effectiveAppearance();
    let names =
        unsafe { NSArray::from_slice(&[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]) };
    match appearance.bestMatchFromAppearancesWithNames(&names) {
        Some(best) => &*best == unsafe { NSAppearanceNameDarkAqua },
        None => dark_mode_default(),
    }
}

fn dark_mode_default() -> bool {
    NSUserDefaults::standardUserDefaults()
        .stringForKey(ns_string!("AppleInterfaceStyle"))
        .is_some_and(|style| style.to_string().eq_ignore_ascii_case("dark"))
}

pub fn attach(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        crate::logger::log(app, "warn", "tray-theme", "not on main thread, skipping");
        return;
    };
    let observer: Retained<ThemeObserver> = unsafe { msg_send![ThemeObserver::alloc(mtm), init] };

    match crate::tray_drop::find_status_button(mtm) {
        Some(button) => {
            unsafe {
                button.addObserver_forKeyPath_options_context(
                    &observer,
                    ns_string!("effectiveAppearance"),
                    NSKeyValueObservingOptions::New,
                    std::ptr::null_mut(),
                );
            }
            let _ = BUTTON.set(ButtonHandle(Retained::into_raw(button).cast()));
        }
        None => crate::logger::log(
            app,
            "warn",
            "tray-theme",
            "status bar button not found, falling back to AppleInterfaceStyle",
        ),
    }

    unsafe {
        NSDistributedNotificationCenter::defaultCenter().addObserver_selector_name_object(
            &observer,
            objc2::sel!(appearanceChanged:),
            Some(&NSString::from_str(THEME_CHANGED)),
            None,
        );
    }
    // Neither KVO nor the notification center retains its observer, so it has
    // to outlive this scope — it lives as long as the tray, i.e. the process.
    let _ = Retained::into_raw(observer);

    crate::tray::set_menubar_dark(current_dark());
}
