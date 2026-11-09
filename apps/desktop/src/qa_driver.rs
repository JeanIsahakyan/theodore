//! Live click-testing (docs/live-qa.md): runs JS from `<dir>/in/<id>.js` in the
//! main webview and writes its JSON result to `<dir>/out/<id>.json`, plus the
//! window number to `<dir>/window`, so a script can drive the real app without
//! the mouse.
//!
//! Whoever can write to `<dir>` has every Tauri command, so this module exists
//! only behind the `qa-driver` cargo feature, and `build.rs` fails a build with
//! that feature outside `dev` (`build_stamp::qa_driver_error`).
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Listener, Manager};

pub fn start(app: &tauri::AppHandle) {
    let Some(dir) = std::env::var_os("THEODORE_QA_DRIVER").map(PathBuf::from) else {
        return;
    };
    let _ = std::fs::create_dir_all(dir.join("in"));
    let _ = std::fs::create_dir_all(dir.join("out"));
    let out = dir.join("out");
    app.listen_any("qa-result", move |e| {
        let v: serde_json::Value = serde_json::from_str(e.payload()).unwrap_or_default();
        let id = v["id"].as_str().unwrap_or("unknown").to_string();
        let path = out.join(format!("{id}.json"));
        let tmp = out.join(format!("{id}.tmp"));
        let _ = std::fs::write(&tmp, v["value"].to_string());
        let _ = std::fs::rename(tmp, path);
    });
    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window("main")
        && let Ok(ptr) = main.ns_window()
    {
        #[allow(unsafe_code)]
        let number = unsafe { (*(ptr as *const objc2_app_kit::NSWindow)).windowNumber() };
        let _ = std::fs::write(dir.join("window"), number.to_string());
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let Ok(entries) = std::fs::read_dir(dir.join("in")) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("js") {
                    continue;
                }
                let id = path
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let Ok(body) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let _ = std::fs::remove_file(&path);
                let script = format!(
                    "(async()=>{{let value;try{{value={{ok:await (async()=>{{{body}\n}})()}}}}catch(e){{value={{err:String(e&&e.stack||e)}}}}\
                     window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{{event:'qa-result',payload:{{id:{id:?},value}}}})}})()"
                );
                if let Some(main) = handle.get_webview_window("main") {
                    let _ = main.eval(&script);
                }
            }
        }
    });
}
