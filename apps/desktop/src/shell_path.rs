//! A GUI app started from Finder or the Dock gets launchd's minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so `claude`, `codex`, `gemini` and
//! `gh` — usually in `~/.local/bin`, Homebrew or a version manager — would
//! all read as "not found". At startup the app takes the user's login-shell
//! `PATH`, adds the usual install dirs, and re-execs itself with it (the
//! workspace forbids `unsafe`, so `std::env::set_var` is out; `exec` keeps
//! the same process and pid).

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const MARK: &str = "__THEODORE_PATH__";

/// Ordered, de-duplicated union: the login shell's entries first, then
/// what the process already had, then common install dirs that exist.
pub fn merge_paths(shell: Option<&str>, current: &str, extra: &[PathBuf]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: &str| {
        if !p.is_empty() && !out.iter().any(|q| q == p) {
            out.push(p.to_string());
        }
    };
    for p in shell.unwrap_or("").split(':') {
        push(p);
    }
    for p in current.split(':') {
        push(p);
    }
    for p in extra {
        if let Some(s) = p.to_str() {
            push(s);
        }
    }
    out.join(":")
}

/// The `PATH` an interactive login shell would have, or `None` if the
/// shell fails or takes longer than two seconds (a slow rc file must not
/// hold up launch).
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let out = Command::new(shell)
            .args([
                "-l",
                "-i",
                "-c",
                &format!("printf '{MARK}%s{MARK}' \"$PATH\""),
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(2)).ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let start = text.find(MARK)? + MARK.len();
    let end = start + text[start..].find(MARK)?;
    Some(text[start..end].to_string())
}

fn common_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    [
        home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".cargo/bin"),
        home.join(".bun/bin"),
    ]
    .into_iter()
    .filter(|p| p.is_dir())
    .collect()
}

#[cfg(not(unix))]
pub fn inherit_login_path() {}

/// Set on the re-exec'd process so it doesn't loop.
const DONE: &str = "THEODORE_PATH_SET";

/// Re-execs this binary with the merged `PATH` when it differs from the
/// current one. Call first thing in `main`. Returns (and the app carries
/// on with the old `PATH`) if the exec fails or nothing needs changing.
#[cfg(unix)]
pub fn inherit_login_path() {
    if std::env::var_os(DONE).is_some() || std::env::var_os("THEODORE_KEEP_PATH").is_some() {
        return;
    }
    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_paths(login_shell_path().as_deref(), &current, &common_dirs());
    if merged == current {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    use std::os::unix::process::CommandExt;
    let err = Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env("PATH", merged)
        .env(DONE, "1")
        .exec();
    eprintln!("theodore: keeping the launch PATH, re-exec failed: {err}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_entries_come_first_without_duplicates() {
        let merged = merge_paths(
            Some("/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin"),
            "/usr/bin:/bin",
            &[PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")],
        );
        assert_eq!(
            merged,
            "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin"
        );
    }

    #[test]
    fn falls_back_to_the_current_path_without_a_shell() {
        assert_eq!(merge_paths(None, "/usr/bin:/bin", &[]), "/usr/bin:/bin");
    }
}
