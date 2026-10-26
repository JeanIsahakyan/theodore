//! Native window chrome the config can't express.

/// An empty unified toolbar on `window`. macOS 26 draws the larger window
/// controls only in windows with a toolbar; the webview still fills the
/// window (`titleBarStyle: Overlay`), so the toolbar shows nothing itself.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub fn unified_toolbar(window: &tauri::WebviewWindow) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSToolbar, NSWindowToolbarStyle};

    let (Some(mtm), Some(ns_window)) = (MainThreadMarker::new(), ns_window(window)) else {
        return;
    };
    let toolbar = NSToolbar::new(mtm);
    ns_window.setToolbar(Some(&toolbar));
    ns_window.setToolbarStyle(NSWindowToolbarStyle::Unified);
}

#[cfg(not(target_os = "macos"))]
pub fn unified_toolbar(_window: &tauri::WebviewWindow) {}

/// Where the window controls sit over the webview, in points from the
/// window's top left. Both 0 in full screen, where the controls hide.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Insets {
    /// The right edge of the zoom button.
    pub controls_end: f64,
    /// The bottom edge of the controls.
    pub controls_bottom: f64,
}

impl Insets {
    /// The script that hands the insets to the UI as CSS variables
    /// (`--controls-end`, `--controls-bottom`; `styles.css` has defaults).
    pub fn script(self) -> String {
        format!(
            "document.documentElement.style.setProperty('--controls-end','{}px');\
             document.documentElement.style.setProperty('--controls-bottom','{}px')",
            self.controls_end.round(),
            self.controls_bottom.round(),
        )
    }
}

#[cfg(target_os = "macos")]
fn insets(window: &tauri::WebviewWindow) -> Option<Insets> {
    use objc2_app_kit::{NSWindowButton, NSWindowStyleMask};

    let ns_window = ns_window(window)?;
    let hidden = Insets {
        controls_end: 0.0,
        controls_bottom: 0.0,
    };
    // Full screen keeps a toolbar on screen as an empty band over the page:
    // hide it there, show it again on the way out.
    let full_screen = ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen);
    if let Some(toolbar) = ns_window.toolbar() {
        toolbar.setVisible(!full_screen);
    }
    if full_screen {
        return Some(hidden);
    }
    let Some(zoom) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return Some(hidden);
    };
    // Window coordinates: origin at the bottom left.
    let r = zoom.convertRect_toView(zoom.bounds(), None);
    let height = ns_window.frame().size.height;
    Some(Insets {
        controls_end: r.origin.x + r.size.width,
        controls_bottom: height - r.origin.y,
    })
}

#[cfg(not(target_os = "macos"))]
fn insets(_window: &tauri::WebviewWindow) -> Option<Insets> {
    None
}

/// Sends the current insets to the page. Run on load and on every resize:
/// entering or leaving full screen is a resize.
pub fn sync_insets(window: &tauri::WebviewWindow) {
    if let Some(i) = insets(window) {
        let _ = window.eval(i.script());
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
fn ns_window(window: &tauri::WebviewWindow) -> Option<&objc2_app_kit::NSWindow> {
    let ptr = window.ns_window().ok()?;
    // SAFETY: Tauri's `ns_window` is the live `NSWindow` behind `window`,
    // and the borrow doesn't outlive it.
    Some(unsafe { &*ptr.cast::<objc2_app_kit::NSWindow>() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insets_become_rounded_css_variables() {
        let s = Insets {
            controls_end: 77.6,
            controls_bottom: 33.2,
        }
        .script();
        assert!(s.contains("'--controls-end','78px'"));
        assert!(s.contains("'--controls-bottom','33px'"));
    }
}
