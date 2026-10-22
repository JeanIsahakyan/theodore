//! Tauri 2 desktop shell (plan §11). Owns windows, the updater and the
//! command/event wiring; delegates all behaviour to `State<Arc<dyn CoreApi>>`.

pub mod app_core;
pub mod commands;
pub mod core_api;
pub mod events;
pub mod menu;
pub mod shell_path;
pub mod updater;

use std::path::Path;
use std::sync::Arc;

use tauri_specta::{Builder, collect_commands};

pub use core_api::{CoreApi, NotReadyCoreApi};
pub use events::{CoreEvents, emitter};

/// Commands + extra types exported to TS. Shared between the running app
/// (`run`) and the bindings exporter (`export_bindings`) so they never drift.
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::bootstrap,
            commands::catch_up,
            commands::transact,
            commands::open_pr,
            commands::get_revision,
            commands::get_file,
            commands::regroup,
            commands::run_skill,
            commands::ask,
            commands::cancel_run,
            commands::submit_review,
            commands::detect_agents,
            commands::app_info,
            commands::check_update,
            commands::install_update,
            commands::refresh_inbox,
            commands::viewer,
            commands::host_status,
            commands::host_status_for,
            commands::set_host_token,
            commands::reply_thread,
            commands::resolve_thread,
            commands::list_skills,
            commands::delegate_task,
            commands::decide_task,
            commands::list_host_repos,
            commands::add_project,
            commands::remove_project,
            commands::refresh_project,
            commands::list_branches,
            commands::open_branch,
            commands::merge_info,
            commands::merge_pr,
            commands::assignable_users,
            commands::set_reviewers,
            commands::set_draft,
            commands::update_branch,
            commands::react,
            commands::edit_comment,
            commands::commit_suggestions,
            commands::get_skill,
            commands::save_skill,
            commands::pr_spend,
            commands::pick_folder,
            commands::interdiff,
            commands::login_start,
            commands::login_poll,
            commands::rerun_check,
            commands::triage,
            commands::set_linear_token,
            commands::linear_status,
            commands::linear_issues,
            commands::find_symbol,
            commands::get_blob,
            commands::conflicts,
            commands::sandbox_status,
            commands::sandbox_set_fault,
            commands::sandbox_fire_event,
            commands::project_working_state,
            commands::close_branch_review,
            commands::create_space,
            commands::list_spaces,
            commands::space_send,
            commands::space_stop,
            commands::space_review,
            commands::archive_space,
            commands::account_status,
            commands::account_sign_in_start,
            commands::account_sign_in_poll,
            commands::account_sign_in_cancel,
            commands::account_sign_out,
            commands::focus_window,
        ])
        // Not a command return type, but still an event payload the UI needs.
        .typ::<theodore_contract::Ephemeral>()
        // Sync ids and unix-ms timestamps stay far below 2^53 (contract crate
        // makes the same call via its own u64/i64 -> u32/i32 remap).
        .dangerously_cast_bigints_to_number()
}

/// Writes the TS command bindings to `out` (default `ui/src/gen/bindings.ts`,
/// relative to the workspace root). Strips the trailing whitespace Specta
/// leaves after `|`, like `crates/contract/src/bin/export-ts.rs`.
pub fn export_bindings(out: impl AsRef<Path>) -> Result<(), String> {
    let out = out.as_ref();
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    specta_builder()
        .export(specta_typescript::Typescript::default(), out)
        .map_err(|e| e.to_string())?;

    let contents = std::fs::read_to_string(out).map_err(|e| e.to_string())?;
    let mut clean: String = contents
        .lines()
        .map(|l| format!("{}\n", l.trim_end()))
        .collect();
    while clean.ends_with("\n\n") {
        clean.pop();
    }
    std::fs::write(out, clean).map_err(|e| e.to_string())
}

/// Runs the Theodore desktop shell. `core` is the use-case implementation;
/// `forward` receives the event emitter once the app is up, to pipe the
/// core's sync and ephemeral streams to the UI.
pub fn run(
    core: Arc<dyn CoreApi>,
    sandbox: bool,
    forward: impl FnOnce(CoreEvents<tauri::Wry>) + Send + 'static,
) {
    let builder = specta_builder();
    // Sandbox and real windows share one webview storage (same app id), so
    // the UI namespaces its `localStorage` keys by this (tabs, onboarding,
    // last-seen heads): a sandbox session never leaks into the real one.
    let storage_ns = tauri::plugin::Builder::<tauri::Wry>::new("storage-ns")
        .js_init_script(format!(
            "window.__THEODORE_STORAGE_NS__ = {:?};",
            if sandbox { "sandbox:" } else { "" }
        ))
        .build();

    tauri::Builder::default()
        .plugin(storage_ns)
        // Native menu bar. Its Edit submenu is also what makes ⌘C / ⌘V /
        // ⌘X / ⌘A / ⌘Z work inside text fields on macOS.
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .manage(core.clone())
        .manage(updater::UpdateState::default())
        .setup(move |app| {
            builder.mount_events(app);
            let handle = app.handle().clone();
            forward(emitter(handle.clone()));
            updater::spawn_periodic_check(handle, core.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Theodore app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_bindings_writes_a_commands_object() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("bindings.ts");
        export_bindings(&out).expect("export bindings");
        let written = std::fs::read_to_string(&out).expect("read generated bindings");
        assert!(written.contains("export const commands"));
        assert!(written.contains("bootstrap"));
        // No trailing whitespace on any line (the commit hook rejects it).
        assert!(written.lines().all(|l| l == l.trim_end()));
    }
}
