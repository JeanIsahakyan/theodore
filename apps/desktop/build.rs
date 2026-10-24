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

    commit();
    tauri_build::build();
}

/// `THEODORE_COMMIT` for the problem report and remote records: the
/// release scripts' value, else `git rev-parse --short HEAD`, else
/// `unknown`.
fn commit() {
    println!("cargo:rerun-if-env-changed=THEODORE_COMMIT");
    let commit = std::env::var("THEODORE_COMMIT")
        .ok()
        .filter(|c| !c.trim().is_empty())
        .or_else(|| {
            let out = std::process::Command::new("git")
                .args(["rev-parse", "--short=12", "HEAD"])
                .output()
                .ok()?;
            let head = String::from_utf8(out.stdout).ok()?.trim().to_string();
            (out.status.success() && !head.is_empty()).then_some(head)
        })
        .unwrap_or_else(|| "unknown".into());
    // Rebuild when HEAD moves (a worktree's HEAD lives in its own git dir).
    if let Ok(out) = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "HEAD"])
        .output()
        && out.status.success()
    {
        let head = String::from_utf8_lossy(&out.stdout).trim().to_string();
        println!("cargo:rerun-if-changed={head}");
    }
    println!("cargo:rustc-env=THEODORE_COMMIT={commit}");
}
