#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;

use theodore_desktop::{NotReadyCoreApi, export_bindings, run};

/// `cargo run -p theodore-desktop -- --export-bindings` writes
/// `ui/src/gen/bindings.ts` without opening a window (used by CI and by hand
/// after changing a command signature); otherwise launches the app.
fn main() {
    if std::env::args().any(|a| a == "--export-bindings") {
        let out = "ui/src/gen/bindings.ts";
        export_bindings(out).expect("export TS bindings");
        println!("wrote {out}");
        return;
    }

    tracing_subscriber::fmt::init();
    run(Arc::new(NotReadyCoreApi));
}
