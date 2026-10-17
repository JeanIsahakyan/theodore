//! `ui/` is built by a separate agent in parallel. `tauri.conf.json` points
//! `frontendDist` at `../../ui/dist`; `tauri_build::build()` reads that
//! directory at compile time, so `cargo check`/`clippy`/`test` need it to
//! exist even before the UI package does. Create a placeholder index.html
//! only if the real build hasn't put one there yet — never overwrite it.

use std::path::Path;

fn main() {
    let dist = Path::new("../../ui/dist");
    let index = dist.join("index.html");
    if !index.exists() {
        std::fs::create_dir_all(dist).expect("create ui/dist placeholder dir");
        std::fs::write(
            &index,
            "<!doctype html>\n<!-- placeholder: replaced by `pnpm -C ui build` -->\n",
        )
        .expect("write ui/dist placeholder index.html");
    }

    tauri_build::build();
}
