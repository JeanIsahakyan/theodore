//! A space's "turn finished" notification and what a click on it does
//! (docs/spaces.md, Notifications).
//!
//! ```text
//! UI ── notify_space(space, title, body) ──▶ Notifier::show
//!   macOS app bundle ── mac-notification-sys, a thread waits per notification
//!   │    click ──▶ focus_main ──▶ emit `open-space` <id> ──▶ UI opens the space
//!   │    returns true: the UI keeps no fallback
//!   elsewhere (dev run, bare binary, other OS) ── notification plugin
//!        returns false: the UI opens the space on the next window focus
//! ```

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime};

/// Event carrying the id of the space whose notification was clicked.
pub const EVENT_OPEN_SPACE: &str = "open-space";

/// What the notification says.
pub struct Notice {
    pub title: String,
    pub body: Option<String>,
}

/// Runs once, when the user clicks the notification.
pub type OnClick = Box<dyn FnOnce() + Send + 'static>;

/// Shows notifications.
pub trait Notifier: Send + Sync {
    /// Shows `notice`. `true` when a click on it will run `on_click`;
    /// `false` when this notifier can't tell (the click is lost).
    fn show(&self, notice: Notice, on_click: OnClick) -> bool;
}

/// What a click does to the app window.
pub trait SpaceWindow: Send + 'static {
    /// Brings the main window forward.
    fn focus(&self);
    /// Tells the UI to open `space`.
    fn open_space(&self, space: &str);
}

/// Shows `notice` for `space`; a click focuses the window, then opens the
/// space. Returns whether the click will be reported.
pub fn notify_space(
    notifier: &dyn Notifier,
    window: impl SpaceWindow,
    space: String,
    notice: Notice,
) -> bool {
    notifier.show(
        notice,
        Box::new(move || {
            window.focus();
            window.open_space(&space);
        }),
    )
}

/// The real window: the existing focus helper and a Tauri event.
pub struct MainWindow<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> SpaceWindow for MainWindow<R> {
    fn focus(&self) {
        if let Err(err) = crate::commands::focus_main(&self.0) {
            tracing::warn!(
                ?err,
                "failed to focus the window after a notification click"
            );
        }
    }

    fn open_space(&self, space: &str) {
        if let Err(err) = self.0.emit(EVENT_OPEN_SPACE, space) {
            tracing::warn!(?err, "failed to emit open-space");
        }
    }
}

/// The notification plugin: shows the notification, never reports a click.
pub struct PluginNotifier<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> Notifier for PluginNotifier<R> {
    fn show(&self, notice: Notice, _on_click: OnClick) -> bool {
        use tauri_plugin_notification::NotificationExt;
        let mut builder = self.0.notification().builder().title(notice.title);
        if let Some(body) = notice.body {
            builder = builder.body(body);
        }
        if let Err(err) = builder.show() {
            tracing::warn!(?err, "failed to show a notification");
        }
        false
    }
}

/// The notifier for this process: clicks reported on macOS from an app
/// bundle, the plugin everywhere else.
pub fn for_app<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn Notifier> {
    #[cfg(target_os = "macos")]
    if let Some(mac) = mac::MacNotifier::new(&app.config().identifier) {
        return Arc::new(mac);
    }
    Arc::new(PluginNotifier(app.clone()))
}

/// At most `max` holders at once; a slot frees itself when dropped.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod slots {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    pub struct Slots {
        used: Arc<AtomicUsize>,
        max: usize,
    }

    pub struct Slot(Arc<AtomicUsize>);

    impl Slots {
        pub fn new(max: usize) -> Self {
            Self {
                used: Arc::default(),
                max,
            }
        }

        /// A free slot, or `None` when all `max` are taken.
        pub fn take(&self) -> Option<Slot> {
            if self.used.fetch_add(1, Ordering::AcqRel) >= self.max {
                self.used.fetch_sub(1, Ordering::AcqRel);
                return None;
            }
            Some(Slot(self.used.clone()))
        }

        #[cfg(test)]
        pub fn used(&self) -> usize {
            self.used.load(Ordering::Acquire)
        }
    }

    impl Drop for Slot {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

/// `NSUserNotificationCenter` through `mac-notification-sys` (the crate the
/// notification plugin itself uses on macOS), asked to wait for the click.
/// The plugin's own click reporting never waits for a notification without
/// buttons, so it's bypassed here.
///
/// Sending blocks until the user clicks the notification, closes it, or it
/// leaves Notification Center (the crate polls for that every 0.5 s), so
/// each one waits on a thread of its own. A notification left in
/// Notification Center keeps its thread until the app quits; at most
/// [`MAX_WAITING`] wait at once, later ones are shown without waiting and
/// fall back to the UI's next-focus approximation.
///
/// Clicks only reach this process when the notification is posted under
/// the app's own bundle identifier, i.e. from inside `Theodore.app`. A dev
/// run or a bare binary posts as Terminal (the plugin's choice), and the
/// click goes to Terminal, so those keep the plugin.
#[cfg(target_os = "macos")]
mod mac {
    use mac_notification_sys::{Notification, NotificationResponse};

    use super::slots::Slots;
    use super::{Notice, Notifier, OnClick};

    /// Notifications waiting for a click at once.
    pub const MAX_WAITING: usize = 16;

    pub struct MacNotifier {
        waiting: Slots,
    }

    impl MacNotifier {
        /// `None` outside an app bundle, or when macOS doesn't know the
        /// app's bundle identifier (the click couldn't come back).
        pub fn new(identifier: &str) -> Option<Self> {
            let exe = std::env::current_exe().ok()?;
            if !crate::deep_link::in_app_bundle(&exe) {
                return None;
            }
            // Must run before the first send: otherwise the crate looks an
            // identifier up through AppleScript and posts as Finder.
            if let Err(err) = mac_notification_sys::set_application(identifier) {
                tracing::warn!(%err, "notifications can't report clicks");
                return None;
            }
            Some(Self {
                waiting: Slots::new(MAX_WAITING),
            })
        }
    }

    /// Shows `notice`; with `wait`, blocks until it's clicked, closed or
    /// gone and runs `on_click` on a click.
    fn deliver(notice: &Notice, wait: bool, on_click: OnClick) {
        let mut n = Notification::new();
        n.title(&notice.title)
            .message(notice.body.as_deref().unwrap_or(""));
        if wait {
            n.wait_for_click(true);
        } else {
            n.asynchronous(true);
        }
        match n.send() {
            Ok(NotificationResponse::Click | NotificationResponse::ActionButton(_)) if wait => {
                on_click()
            }
            Ok(_) => {}
            Err(err) => tracing::warn!(%err, "failed to show a notification"),
        }
    }

    impl Notifier for MacNotifier {
        fn show(&self, notice: Notice, on_click: OnClick) -> bool {
            let slot = self.waiting.take();
            let wait = slot.is_some();
            let spawned = std::thread::Builder::new()
                .name("notification".into())
                .spawn(move || {
                    let _slot = slot;
                    deliver(&notice, wait, on_click);
                });
            if let Err(err) = &spawned {
                tracing::warn!(%err, "failed to start a notification thread");
            }
            wait && spawned.is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::slots::Slots;
    use super::*;

    /// Keeps the click callback so the test can "click".
    #[derive(Default)]
    struct FakeNotifier {
        shown: Mutex<Vec<(String, Option<String>, OnClick)>>,
    }

    impl Notifier for FakeNotifier {
        fn show(&self, notice: Notice, on_click: OnClick) -> bool {
            self.shown
                .lock()
                .unwrap()
                .push((notice.title, notice.body, on_click));
            true
        }
    }

    #[derive(Clone, Default)]
    struct FakeWindow(Arc<Mutex<Vec<String>>>);

    impl SpaceWindow for FakeWindow {
        fn focus(&self) {
            self.0.lock().unwrap().push("focus".into());
        }
        fn open_space(&self, space: &str) {
            self.0.lock().unwrap().push(format!("open {space}"));
        }
    }

    #[test]
    fn a_click_focuses_the_window_then_opens_the_space() {
        let notifier = FakeNotifier::default();
        let window = FakeWindow::default();
        let notice = Notice {
            title: "fix-login: turn finished".into(),
            body: None,
        };

        assert!(notify_space(
            &notifier,
            window.clone(),
            "sp1".into(),
            notice
        ));
        // Shown, nothing happens until the click.
        assert!(window.0.lock().unwrap().is_empty());

        let (title, body, click) = notifier.shown.lock().unwrap().pop().unwrap();
        assert_eq!(title, "fix-login: turn finished");
        assert_eq!(body, None);
        click();
        assert_eq!(*window.0.lock().unwrap(), ["focus", "open sp1"]);
    }

    #[test]
    fn a_notifier_without_clicks_says_so() {
        struct Blind;
        impl Notifier for Blind {
            fn show(&self, _: Notice, _: OnClick) -> bool {
                false
            }
        }
        let window = FakeWindow::default();
        let notice = Notice {
            title: "fix: turn failed".into(),
            body: Some("boom".into()),
        };
        assert!(!notify_space(&Blind, window.clone(), "sp1".into(), notice));
        assert!(window.0.lock().unwrap().is_empty());
    }

    #[test]
    fn waiting_notifications_are_capped_and_free_their_slot() {
        let slots = Slots::new(2);
        let a = slots.take().expect("first");
        let _b = slots.take().expect("second");
        assert!(slots.take().is_none());
        drop(a);
        assert_eq!(slots.used(), 1);
        assert!(slots.take().is_some());
    }
}
