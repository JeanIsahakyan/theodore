//! `ui/` is built by a separate agent in parallel. `tauri.conf.json` points
//! `frontendDist` at `../../ui/dist`; `tauri_build::build()` reads that
//! directory at compile time, so `cargo check`/`clippy`/`test` need it to
//! exist even before the UI package does. Create a placeholder index.html
//! only if the real build hasn't put one there yet — never overwrite it.

use std::path::Path;
use std::process::Command;

#[allow(dead_code)]
#[path = "src/build_stamp.rs"]
mod build_stamp;

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

    stamp();
    tauri_build::build();
}

/// The build stamp (`src/build_info.rs`), baked in as `THEODORE_*` env:
///
/// - `THEODORE_VERSION`: from the env (a nightly's `-nightly.N`), else the
///   crate version.
/// - `THEODORE_BUILD_ENV`: `production` | `staging` | `nightly` | `dev`
///   (unset: `dev`; anything else fails the build).
/// - `THEODORE_COMMIT`: the full sha from `THEODORE_GIT_SHA`, else
///   `git rev-parse HEAD`, else `unknown`; dev builds from a dirty tree
///   get `-dirty`.
/// - `THEODORE_BUILT_AT`: unix millis when this script last ran.
///
/// Reruns when those env vars, HEAD or the branch it points to change —
/// not on every edit, so a dev build's `-dirty` and date are as of the
/// last rerun (a commit, a checkout, a clean build).
fn stamp() {
    for var in ["THEODORE_VERSION", "THEODORE_BUILD_ENV", "THEODORE_GIT_SHA"] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    let version = std::env::var("THEODORE_VERSION")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    let env = build_stamp::build_env(std::env::var("THEODORE_BUILD_ENV").ok().as_deref())
        .unwrap_or_else(|e| panic!("{e}"));
    let given = std::env::var("THEODORE_GIT_SHA").ok();
    let given = given.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let (sha, dirty) = match given {
        Some(sha) => (Some(sha.to_string()), false),
        None => {
            let sha = git(&["rev-parse", "HEAD"]);
            // Only a dev build can be dirty; skip `git status` otherwise.
            let dirty = sha.is_some()
                && env == "dev"
                && git(&["status", "--porcelain", "--untracked-files=no"]).is_some();
            (sha, dirty)
        }
    };
    // A production/staging/nightly build without the keys CI bakes in has
    // no sign-in and no diagnostics: fail, unless asked to build it anyway,
    // and then mark its commit `-incomplete` (About, problem reports).
    for var in build_stamp::RELEASE_KEYS
        .iter()
        .chain(&["THEODORE_ALLOW_INCOMPLETE_BUILD"])
    {
        println!("cargo:rerun-if-env-changed={var}");
    }
    let missing = build_stamp::missing_keys(env, |k| std::env::var(k).ok());
    let incomplete = !missing.is_empty();
    if incomplete {
        let message = build_stamp::missing_keys_error(env, &missing);
        let allowed = std::env::var("THEODORE_ALLOW_INCOMPLETE_BUILD")
            .is_ok_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
        if !allowed {
            panic!("\n\n{message}\n");
        }
        for line in message.lines() {
            println!("cargo:warning={line}");
        }
    }
    let mut commit = build_stamp::commit(sha.as_deref(), dirty, env);
    if incomplete {
        commit.push_str("-incomplete");
    }
    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    rerun_on_head();
    println!("cargo:rustc-env=THEODORE_VERSION={version}");
    println!("cargo:rustc-env=THEODORE_BUILD_ENV={env}");
    println!("cargo:rustc-env=THEODORE_COMMIT={commit}");
    println!("cargo:rustc-env=THEODORE_BUILT_AT={built_at}");
}

/// Rebuild when HEAD moves: `HEAD` itself (a checkout), the branch it
/// points to (a commit) and `packed-refs` (a branch that isn't loose).
/// `--git-path` resolves each for worktrees too. Only existing files are
/// watched: cargo reruns every build for a missing one.
fn rerun_on_head() {
    let mut paths = vec!["HEAD".to_string(), "packed-refs".to_string()];
    if let Some(branch) = git(&["symbolic-ref", "-q", "HEAD"]) {
        paths.push(branch);
    }
    for p in paths {
        if let Some(path) = git(&["rev-parse", "--git-path", &p])
            && Path::new(&path).exists()
        {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// A git command's trimmed stdout; `None` when git is missing, fails or
/// prints nothing.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}
