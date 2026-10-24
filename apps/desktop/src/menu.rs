//! The native menu bar. App items carry an id; picking one emits a `menu`
//! event with that id and the UI runs the same action as ⌘K. Only ⌘-combos
//! get accelerators — single-letter shortcuts stay in the webview so they
//! never steal typing.

use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

pub const EVENT_MENU: &str = "menu";

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, text);
    if let Some(a) = accel {
        b = b.accelerator(a);
    }
    b.build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let i = |id: &str, text: &str, accel: Option<&str>| item(app, id, text, accel);

    let theodore = SubmenuBuilder::new(app, "Theodore")
        .about(None)
        .item(&i("check-updates", "Check for Updates…", None)?)
        .separator()
        .item(&i("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&i("new-tab", "New Tab", Some("CmdOrCtrl+T"))?)
        .item(&i(
            "open-pr",
            "Open Pull Request…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .item(&i("add-project", "Add Project…", None)?)
        .separator()
        .item(&i("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&i("view-grouped", "Grouped", Some("CmdOrCtrl+1"))?)
        .item(&i("view-files", "Files", Some("CmdOrCtrl+2"))?)
        .item(&i(
            "view-split",
            "Unified / Split Diff",
            Some("CmdOrCtrl+Shift+S"),
        )?)
        .separator()
        .item(&i(
            "toggle-sidebar",
            "Toggle Sidebar",
            Some("CmdOrCtrl+\\"),
        )?)
        .item(&i("toggle-aside", "Toggle AI Panel", Some("CmdOrCtrl+]"))?)
        .item(&i("toggle-theme", "Light / Dark Theme", None)?)
        .separator()
        .item(&i("palette", "Command Palette…", Some("CmdOrCtrl+K"))?)
        .separator()
        .fullscreen()
        .build()?;

    let go = SubmenuBuilder::new(app, "Go")
        .item(&i("go-inbox", "Inbox", Some("CmdOrCtrl+Shift+I"))?)
        .item(&i("go-prs", "Pull Requests", Some("CmdOrCtrl+Shift+P"))?)
        .item(&i(
            "go-mine",
            "My Pull Requests",
            Some("CmdOrCtrl+Shift+M"),
        )?)
        .item(&i("go-tasks", "Tasks", Some("CmdOrCtrl+Shift+T"))?)
        .separator()
        .item(&i("next-tab", "Next Tab", Some("Ctrl+Tab"))?)
        .item(&i("prev-tab", "Previous Tab", Some("Ctrl+Shift+Tab"))?)
        .item(&i("go-back", "Back", Some("CmdOrCtrl+["))?)
        .build()?;

    let review = SubmenuBuilder::new(app, "Review")
        .item(&i(
            "submit-review",
            "Submit Review…",
            // Not plain ⌘↵: that adds a comment in the composer, and a menu
            // accelerator fires on top of whatever the page does with it.
            Some("CmdOrCtrl+Shift+Enter"),
        )?)
        .separator()
        .item(&i("mark-group-read", "Mark Group as Read", None)?)
        .item(&i("ask-agent", "Ask the Agent / Run a Skill", None)?)
        .separator()
        .item(&i("open-on-host", "Open on GitHub", None)?)
        .item(&i("refresh-inbox", "Refresh Inbox", Some("CmdOrCtrl+R"))?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&i("shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+/"))?)
        .item(&i("report-issue", "Report an Issue…", None)?)
        // A zip of the redacted logs + app info to attach (docs/telemetry.md).
        .item(&i("report-problem", "Report a Problem…", None)?)
        .build()?;

    Menu::with_items(
        app,
        &[&theodore, &file, &edit, &view, &go, &review, &window, &help],
    )
}

/// Forwards app menu picks to the UI.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let _ = app.emit(EVENT_MENU, event.id().as_ref().to_string());
}
