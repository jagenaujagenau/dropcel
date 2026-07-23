//! Experimental macOS-only: make the menu-bar (tray) icon a drag-and-drop
//! target. Tauri's tray API doesn't expose this, so we reach into AppKit:
//!
//!  1. find our NSStatusItem's button — it's the content view of the
//!     app's NSStatusBarWindow;
//!  2. isa-swizzle it to a subclass that implements NSDraggingDestination
//!     (no ivars added, so object_setClass is safe; clicks stay native);
//!  3. register for file-URL drags and forward drops to the frontend as a
//!     `tray:drop` event, which feeds the same import path as window drops.
//!
//! Every step is best-effort: if AppKit internals shift, we log and the
//! tray simply remains a non-drop target.
#![cfg(target_os = "macos")]

use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::runtime::Bool;
use objc2::{define_class, msg_send, ClassType, MainThreadMarker, MainThreadOnly, Message};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingInfo, NSPasteboardTypeFileURL, NSStatusBarButton,
    NSView,
};
use objc2_foundation::{NSArray, NSString, NSURL};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

define_class!(
    #[unsafe(super(NSStatusBarButton))]
    #[thread_kind = MainThreadOnly]
    #[name = "VFTrayDropButton"]
    struct TrayDropButton;

    impl TrayDropButton {
        #[unsafe(method(draggingEntered:))]
        fn dragging_entered(&self, _info: &ProtocolObject<dyn NSDraggingInfo>) -> NSDragOperation {
            unsafe {
                let _: () = msg_send![self, setHighlighted: true];
            }
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingExited:))]
        fn dragging_exited(&self, _info: Option<&ProtocolObject<dyn NSDraggingInfo>>) {
            unsafe {
                let _: () = msg_send![self, setHighlighted: false];
            }
        }

        #[unsafe(method(prepareForDragOperation:))]
        fn prepare_for_drag(&self, _info: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
            Bool::YES
        }

        #[unsafe(method(performDragOperation:))]
        fn perform_drag(&self, info: &ProtocolObject<dyn NSDraggingInfo>) -> Bool {
            unsafe {
                let _: () = msg_send![self, setHighlighted: false];
            }
            let paths = dropped_paths(info);
            if paths.is_empty() {
                return Bool::NO;
            }
            if let Some(app) = APP.get() {
                let _ = app.emit("tray:drop", paths);
            }
            Bool::YES
        }
    }
);

fn dropped_paths(info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<String> {
    let mut out = vec![];
    unsafe {
        let pasteboard = info.draggingPasteboard();
        if let Some(items) = pasteboard.pasteboardItems() {
            for item in items {
                if let Some(url_string) = item.stringForType(NSPasteboardTypeFileURL) {
                    if let Some(url) = NSURL::URLWithString(&url_string) {
                        if let Some(path) = url.path() {
                            out.push(path.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Locate the tray icon's NSStatusBarButton among the app's windows.
fn find_status_button(mtm: MainThreadMarker) -> Option<Retained<NSView>> {
    let app = NSApplication::sharedApplication(mtm);
    for window in app.windows() {
        let class_name = unsafe {
            let cls: &objc2::runtime::AnyClass = msg_send![&window, class];
            cls.name().to_string_lossy().to_string()
        };
        if class_name != "NSStatusBarWindow" {
            continue;
        }
        let content: Option<Retained<NSView>> = window.contentView();
        if let Some(view) = content {
            if let Some(button) = find_button_in(&view) {
                return Some(button);
            }
        }
    }
    None
}

fn find_button_in(view: &NSView) -> Option<Retained<NSView>> {
    let is_button: bool =
        unsafe { msg_send![view, isKindOfClass: NSStatusBarButton::class()] };
    if is_button {
        return Some(view.retain());
    }
    for sub in view.subviews() {
        if let Some(found) = find_button_in(&sub) {
            return Some(found);
        }
    }
    None
}

/// Swap the live button's class for our drag-aware subclass and register
/// for file drops. Call on the main thread after the tray is built.
pub fn attach(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        crate::logger::log(app, "warn", "tray-drop", "not on main thread, skipping");
        return;
    };
    let Some(button) = find_status_button(mtm) else {
        crate::logger::log(app, "warn", "tray-drop", "status bar button not found, tray drops disabled");
        return;
    };
    unsafe {
        // Safe isa-swizzle: TrayDropButton adds no ivars over its superclass.
        let ptr = Retained::as_ptr(&button) as *mut objc2::runtime::AnyObject;
        objc2::ffi::object_setClass(
            ptr.cast(),
            (TrayDropButton::class() as *const objc2::runtime::AnyClass).cast(),
        );
        let types = NSArray::from_retained_slice(&[NSString::from_str(
            &NSPasteboardTypeFileURL.to_string(),
        )]);
        button.registerForDraggedTypes(&types);
    }
}
