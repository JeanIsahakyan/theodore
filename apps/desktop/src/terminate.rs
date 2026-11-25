//! macOS: the quit that bypasses Tauri. ⌘Q (the menu's Quit item sends
//! `terminate:`), Dock → Quit, an AppleEvent `quit app "Theodore"` and a
//! log out or shutdown all reach `NSApplication terminate:`. tao's app
//! delegate answers only `applicationWillTerminate:`, which fires
//! `RunEvent::Exit` straight away: no `ExitRequested`, nothing to prevent,
//! and the agents die with the process. This adds
//! `applicationShouldTerminate:` to that delegate so the quit pauses them
//! first (`restart`):
//!
//! ```text
//! terminate: ─▶ applicationShouldTerminate ─┬─ paused, or nothing running ─▶ NSTerminateNow
//!                                            ├─ a pause under way ──────────▶ NSTerminateCancel
//!                                            └─ turns running ─▶ NSTerminateLater
//!                                                 thread: pause ≤ PAUSE_DEADLINE
//!                                                   ─▶ main thread: replyToApplicationShouldTerminate YES
//!                                                        ─▶ applicationWillTerminate ─▶ Exit ─▶ stop spaces, telemetry
//! ```
//!
//! Elsewhere the predefined Quit item exits through Tauri (`ExitRequested`),
//! which `restart::exit_after_pausing` handles; this module is empty there.

use std::sync::Arc;

use crate::CoreApi;

/// Installs the hook. Once, from `setup` (the main thread, after tao set
/// its delegate). Does nothing where tao's delegate already answers.
#[cfg(target_os = "macos")]
pub fn hook(core: Arc<dyn CoreApi>) {
    macos::hook(core);
}

#[cfg(not(target_os = "macos"))]
pub fn hook(_core: Arc<dyn CoreApi>) {}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod macos {
    use std::sync::{Arc, OnceLock};

    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::{MainThreadMarker, msg_send, sel};
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};

    use crate::CoreApi;
    use crate::restart::{self, Wait};

    /// The core the hook pauses through, set once by `hook`.
    static CORE: OnceLock<Arc<dyn CoreApi>> = OnceLock::new();

    /// Our reply method on the delegate: it runs on the main thread (via
    /// `performSelectorOnMainThread:`) and lets the termination go on.
    fn reply_sel() -> Sel {
        sel!(theodoreReplyToShouldTerminate:)
    }

    /// `NSApplicationTerminateReply` as the runtime encodes it (an
    /// `NSUInteger`), `id self`, `SEL _cmd`, `id sender`.
    const SHOULD_TERMINATE_TYPES: &std::ffi::CStr = c"Q@:@";
    /// `void`, `id self`, `SEL _cmd`, `id arg`.
    const REPLY_TYPES: &std::ffi::CStr = c"v@:@";

    pub(super) fn hook(core: Arc<dyn CoreApi>) {
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::warn!(
                error.code = "quit.hook_off_main",
                "not on the main thread: a quit won't pause the agents"
            );
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let Some(delegate) = app.delegate() else {
            tracing::warn!(
                error.code = "quit.no_delegate",
                "the app has no delegate: a quit won't pause the agents"
            );
            return;
        };
        let delegate: &AnyObject = (*delegate).as_ref();
        let class: &AnyClass = delegate.class();
        if class.responds_to(sel!(applicationShouldTerminate:)) {
            // A tao that answers it itself: it then fires `ExitRequested`,
            // which `restart::exit_after_pausing` handles.
            tracing::info!(class = %class.name().to_string_lossy(), "the app delegate answers applicationShouldTerminate: itself");
            return;
        }
        if CORE.set(core).is_err() {
            return;
        }
        // SAFETY: the method implementations below have the signatures the
        // type encodings describe (`id self`, `SEL _cmd`, `id arg`,
        // returning an `NSUInteger` or nothing), as AppKit calls them;
        // `class` is a class the runtime registered and keeps alive;
        // adding a method a class lacks is what `class_addMethod` is for.
        let added = unsafe {
            let class = (class as *const AnyClass).cast_mut();
            let should: unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize =
                should_terminate;
            let reply: unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) =
                reply_to_should_terminate;
            objc2::ffi::class_addMethod(
                class,
                reply_sel(),
                std::mem::transmute::<
                    unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject),
                    objc2::runtime::Imp,
                >(reply),
                REPLY_TYPES.as_ptr(),
            )
            .as_bool()
                && objc2::ffi::class_addMethod(
                    class,
                    sel!(applicationShouldTerminate:),
                    std::mem::transmute::<
                        unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                        objc2::runtime::Imp,
                    >(should),
                    SHOULD_TERMINATE_TYPES.as_ptr(),
                )
                .as_bool()
        };
        if added {
            tracing::debug!("a quit pauses the running agents first (applicationShouldTerminate:)");
        } else {
            tracing::warn!(
                error.code = "quit.hook_failed",
                "couldn't hook applicationShouldTerminate:; a quit won't pause the agents"
            );
        }
    }

    /// The delegate, carried to the pause thread only to post a message
    /// back to the main thread with it.
    struct Delegate(*mut AnyObject);

    // SAFETY: the pointer is only ever handed to
    // `performSelectorOnMainThread:`, which is for calling from any
    // thread; the object itself (tao's delegate) lives as long as the app.
    unsafe impl Send for Delegate {}

    /// `applicationShouldTerminate:` on tao's delegate.
    unsafe extern "C-unwind" fn should_terminate(
        this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        let Some(core) = CORE.get() else {
            return NSApplicationTerminateReply::TerminateNow.0;
        };
        if restart::pausing() {
            // Another quit is pausing them and will exit; this one would
            // only cut it short.
            tracing::info!("quit asked again while the turns are being paused: already quitting");
            return NSApplicationTerminateReply::TerminateCancel.0;
        }
        let delegate = Delegate((this as *const AnyObject).cast_mut());
        let later = restart::pause_then(core.clone(), Wait::Deferred, move || {
            let delegate = delegate;
            // SAFETY: `performSelectorOnMainThread:withObject:waitUntilDone:`
            // is an `NSObject` method meant for other threads; `REPLY` was
            // added to the delegate's class in `hook`. It is queued in the
            // common run loop modes, which the modal mode AppKit runs while
            // it waits for the reply belongs to.
            unsafe {
                let _: () = msg_send![
                    delegate.0,
                    performSelectorOnMainThread: reply_sel(),
                    withObject: std::ptr::null_mut::<AnyObject>(),
                    waitUntilDone: false
                ];
            }
        });
        if later {
            tracing::info!("the quit waits for the pause (NSTerminateLater)");
            NSApplicationTerminateReply::TerminateLater.0
        } else {
            NSApplicationTerminateReply::TerminateNow.0
        }
    }

    /// `theodoreReplyToShouldTerminate:`: on the main thread, after the
    /// pause.
    unsafe extern "C-unwind" fn reply_to_should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _arg: *mut AnyObject,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            tracing::warn!(
                error.code = "quit.reply_off_main",
                "the quit's reply came off the main thread"
            );
            return;
        };
        tracing::info!("turns paused: the quit goes on");
        NSApplication::sharedApplication(mtm).replyToApplicationShouldTerminate(true);
    }
}
