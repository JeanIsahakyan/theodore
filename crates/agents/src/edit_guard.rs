//! Keeps an agent's file-edit tools inside its working directories
//! (docs/spaces.md §5 Safety): the space worktree plus the turn's
//! attachment dirs. Shell commands are not covered; this is no OS sandbox.
//!
//! Claude Code runs a `PreToolUse` hook before every Edit / Write /
//! NotebookEdit, in every permission mode (`bypassPermissions` included).
//! The hook is Theodore's own binary in guard mode:
//!
//! ```text
//! claude ─▶ PreToolUse ─▶ <theodore exe> --theodore-edit-guard <root>… --memory=<dir>…
//!                            stdin: {"tool_input":{"file_path":…},"cwd":…}
//!                            inside a root            ─▶ exit 0   (the edit runs)
//!                            <memory dir>/<name>.md   ─▶ exit 0
//!                            anything else            ─▶ exit 2   (denied, reason → agent)
//! ```
//!
//! The memory dirs are Claude Code's own memory for this project
//! (`<config>/projects/<key>/memory`, `accounts::claude_memory_dirs`): a
//! `.md` file directly in one is allowed, a subdirectory or any other file
//! is not. A guard binary older than the `--memory=` form reads such an
//! argument as a root no path ever resolves to, so it denies as before.
//!
//! A binary only offers itself as the hook after its `main` called
//! [`run_if_requested`], so a host that never handles the flag (a test
//! binary) is never launched as one.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

/// argv[1] of the guard mode.
pub const FLAG: &str = "--theodore-edit-guard";

/// Prefix of an argument naming a memory dir (`--memory=<dir>`); every
/// other argument after [`FLAG`] is a root.
pub const MEMORY_ARG: &str = "--memory=";

static EXE: OnceLock<PathBuf> = OnceLock::new();

/// Call first in `main`. In guard mode (`<exe> --theodore-edit-guard
/// <root>… --memory=<dir>…`) it judges one hook input from stdin and exits
/// the process: 0 allows the edit, 2 denies it with the reason on stderr.
/// Otherwise it returns, and this binary becomes the hook later runs use.
pub fn run_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(OsStr::new(FLAG)) {
        let mut roots: Vec<PathBuf> = Vec::new();
        let mut memory: Vec<PathBuf> = Vec::new();
        for arg in args {
            match arg.to_str().and_then(|s| s.strip_prefix(MEMORY_ARG)) {
                Some(dir) => memory.push(PathBuf::from(dir)),
                None => roots.push(PathBuf::from(arg)),
            }
        }
        let mut input = String::new();
        let verdict = std::io::stdin()
            .read_to_string(&mut input)
            .map_err(|e| format!("unreadable hook input: {e}"))
            .and_then(|_| check(&input, &roots, &memory));
        match verdict {
            Ok(()) => std::process::exit(0),
            Err(why) => {
                eprintln!("{why}");
                std::process::exit(2);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = EXE.set(exe);
    }
}

/// The binary to run as the hook, once `run_if_requested` has set it.
pub fn installed_exe() -> Option<&'static Path> {
    EXE.get().map(PathBuf::as_path)
}

/// The hook's shell command (Claude Code runs it with `sh -c`): the roots,
/// then `--memory=<dir>` for each memory dir.
pub fn hook_command(exe: &Path, roots: &[PathBuf], memory: &[PathBuf]) -> String {
    let mut cmd = shell_quote(&exe.display().to_string());
    cmd.push(' ');
    cmd.push_str(FLAG);
    for root in roots {
        cmd.push(' ');
        cmd.push_str(&shell_quote(&root.display().to_string()));
    }
    for dir in memory {
        cmd.push(' ');
        cmd.push_str(&shell_quote(&format!("{MEMORY_ARG}{}", dir.display())));
    }
    cmd
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `Ok` when the edit in a `PreToolUse` hook input (Claude Code's JSON)
/// lands inside one of `roots`, or is a `.md` file directly in one of the
/// `memory` dirs. Fails closed: no path, a `..` in it, or unreadable input
/// is a denial. Symlinks are resolved on both sides, so a link inside the
/// worktree (or a memory dir) pointing out of it doesn't count as inside.
pub fn check(input: &str, roots: &[PathBuf], memory: &[PathBuf]) -> Result<(), String> {
    let v: Value =
        serde_json::from_str(input).map_err(|e| format!("unreadable hook input: {e}"))?;
    let tool = &v["tool_input"];
    let raw = ["file_path", "notebook_path", "path"]
        .iter()
        .find_map(|k| tool[*k].as_str())
        .ok_or("no file path in this edit")?;
    let mut path = PathBuf::from(raw);
    if path.is_relative() {
        let cwd = v["cwd"].as_str().ok_or("a relative path and no cwd")?;
        path = Path::new(cwd).join(path);
    }
    if path.components().any(|c| c == Component::ParentDir) {
        return Err(format!("{raw}: use a path without `..`"));
    }
    let real = physical(&path);
    if roots.iter().any(|r| real.starts_with(physical(r))) {
        return Ok(());
    }
    if is_memory_file(&real, memory) {
        return Ok(());
    }
    let inside = roots
        .first()
        .map_or_else(String::new, |r| format!(" inside {}", r.display()));
    let or_memory = if memory.is_empty() {
        ""
    } else {
        " or as a .md file in Claude's memory directory for this project"
    };
    Err(format!(
        "{raw} is outside this space; edit files only{inside}{or_memory}"
    ))
}

/// `real` (symlinks resolved) is `<dir>/<name>.md` for one of the memory
/// dirs: directly in it, no subdirectory, a `.md` extension.
fn is_memory_file(real: &Path, memory: &[PathBuf]) -> bool {
    if real.extension() != Some(OsStr::new("md")) {
        return false;
    }
    let Some(parent) = real.parent() else {
        return false;
    };
    memory.iter().any(|m| parent == physical(m))
}

/// `p` with symlinks resolved on its deepest existing ancestor (the file
/// itself may not exist yet). A dangling symlink counts as where it points:
/// a write through it creates that file.
fn physical(p: &Path) -> PathBuf {
    physical_within(p, MAX_LINKS).unwrap_or_default()
}

/// Links followed before a path counts as unresolvable, as the OS does.
const MAX_LINKS: u32 = 40;

/// `None`, inside no root: a path that never resolves (a link loop, a
/// missing directory with `..` after it).
fn physical_within(p: &Path, links: u32) -> Option<PathBuf> {
    let mut base = p;
    let mut rest = Vec::new();
    loop {
        let found = if let Ok(real) = std::fs::canonicalize(base) {
            Some(real)
        } else if let Ok(target) = std::fs::read_link(base) {
            let target = base
                .parent()
                .map_or(target.clone(), |dir| dir.join(&target));
            Some(physical_within(&target, links.checked_sub(1)?)?)
        } else {
            None
        };
        if let Some(real) = found {
            return Some(rest.iter().rev().fold(real, |acc, c| acc.join(c)));
        }
        match (base.parent(), base.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                base = parent;
            }
            _ if p.components().any(|c| c == Component::ParentDir) => return None,
            _ => return Some(p.to_path_buf()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(path: &str) -> String {
        serde_json::json!({
            "cwd": "/nowhere",
            "tool_name": "Write",
            "tool_input": { "file_path": path, "content": "x" },
        })
        .to_string()
    }

    #[test]
    fn edits_inside_a_root_pass_and_outside_are_denied() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let att = tmp.path().join("att");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&att).unwrap();
        let roots = vec![ws.clone(), att.clone()];
        let at = |p: &Path| input(&p.display().to_string());

        assert!(check(&at(&ws.join("new/dir/file.rs")), &roots, &[]).is_ok());
        assert!(check(&at(&att.join("shot.png")), &roots, &[]).is_ok());
        let err = check(&at(&tmp.path().join("other/x.txt")), &roots, &[]).unwrap_err();
        assert!(err.contains("outside this space"), "{err}");
        assert!(check(&at(&ws.join("../other/x.txt")), &roots, &[]).is_err());
        // A sibling whose name only starts with the root's.
        assert!(check(&at(&tmp.path().join("ws-2/x")), &roots, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_worktree_is_outside() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::os::unix::fs::symlink(&out, ws.join("link")).unwrap();
        let roots = vec![ws.clone()];
        let p = ws.join("link/x.txt").display().to_string();
        assert!(check(&input(&p), &roots, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_out_of_the_worktree_is_outside() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let roots = vec![ws.clone()];
        let at = |p: &Path| input(&p.display().to_string());
        // A write through one creates the file it names.
        std::os::unix::fs::symlink(tmp.path().join("out/new.txt"), ws.join("abs")).unwrap();
        std::os::unix::fs::symlink("../out.txt", ws.join("rel")).unwrap();
        assert!(check(&at(&ws.join("abs")), &roots, &[]).is_err());
        assert!(check(&at(&ws.join("rel")), &roots, &[]).is_err());
        // Through a dangling link in the middle of the path too.
        std::os::unix::fs::symlink(tmp.path().join("gone"), ws.join("dir")).unwrap();
        assert!(check(&at(&ws.join("dir/new.txt")), &roots, &[]).is_err());
        // A loop never resolves, so it is never inside.
        std::os::unix::fs::symlink("loop", ws.join("loop")).unwrap();
        assert!(check(&at(&ws.join("loop")), &roots, &[]).is_err());
        // Dangling, but inside.
        std::os::unix::fs::symlink("not-yet.txt", ws.join("in")).unwrap();
        assert!(check(&at(&ws.join("in")), &roots, &[]).is_ok());
    }

    #[test]
    fn relative_paths_resolve_against_cwd_and_bad_input_is_denied() {
        let tmp = tempfile::tempdir().unwrap();
        let roots = vec![tmp.path().to_path_buf()];
        let rel = serde_json::json!({
            "cwd": tmp.path(),
            "tool_input": { "notebook_path": "nb.ipynb" },
        })
        .to_string();
        assert!(check(&rel, &roots, &[]).is_ok());
        assert!(check("not json", &roots, &[]).is_err());
        assert!(check(r#"{"tool_input":{}}"#, &roots, &[]).is_err());
    }

    /// Claude's memory for this project: `.md` files directly in the memory
    /// dir, nothing else outside the worktree.
    #[test]
    fn memory_files_of_this_project_pass_and_everything_else_outside_is_denied() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let memory = tmp.path().join("cfg/projects/-data-spaces-a1/memory");
        let other = tmp.path().join("cfg/projects/-data-spaces-b2/memory");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let roots = vec![ws.clone()];
        let mem = vec![memory.clone()];
        let at = |p: &Path| input(&p.display().to_string());

        assert!(check(&at(&memory.join("english-git-artifacts.md")), &roots, &mem).is_ok());
        assert!(check(&at(&memory.join("MEMORY.md")), &roots, &mem).is_ok());
        // A subdirectory, `..`, another project's memory, a non-.md file.
        assert!(check(&at(&memory.join("sub/note.md")), &roots, &mem).is_err());
        assert!(check(&at(&memory.join("../memory/note.md")), &roots, &mem).is_err());
        assert!(
            check(
                &at(&memory.join("../../-data-spaces-b2/memory/x.md")),
                &roots,
                &mem
            )
            .is_err()
        );
        assert!(check(&at(&other.join("note.md")), &roots, &mem).is_err());
        assert!(check(&at(&memory.join("notes.txt")), &roots, &mem).is_err());
        assert!(check(&at(&memory.join(".md")), &roots, &mem).is_err());
        assert!(
            check(
                &at(&memory.parent().unwrap().join("session.md")),
                &roots,
                &mem
            )
            .is_err()
        );
        // The memory dir itself is a directory, not a memory file.
        assert!(check(&at(&memory), &roots, &mem).is_err());
        // The worktree rules are unchanged next to it.
        assert!(check(&at(&ws.join("src/lib.rs")), &roots, &mem).is_ok());
        let err = check(&at(&tmp.path().join("other/x.txt")), &roots, &mem).unwrap_err();
        assert!(err.contains("outside this space"), "{err}");
        assert!(err.contains("memory directory"), "{err}");
        // Without a memory dir, memory files stay denied.
        assert!(check(&at(&memory.join("MEMORY.md")), &roots, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_memory_dir_is_denied() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let memory = tmp.path().join("cfg/projects/-data-spaces-a1/memory");
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        let roots = vec![ws.clone()];
        let mem = vec![memory.clone()];
        let at = |p: &Path| input(&p.display().to_string());
        // A link to a file outside, existing or not, and a linked directory.
        std::fs::write(out.join("target.md"), "x").unwrap();
        std::os::unix::fs::symlink(out.join("target.md"), memory.join("link.md")).unwrap();
        std::os::unix::fs::symlink(out.join("new.md"), memory.join("dangling.md")).unwrap();
        std::os::unix::fs::symlink(&out, memory.join("dir")).unwrap();
        assert!(check(&at(&memory.join("link.md")), &roots, &mem).is_err());
        assert!(check(&at(&memory.join("dangling.md")), &roots, &mem).is_err());
        assert!(check(&at(&memory.join("dir/x.md")), &roots, &mem).is_err());
        // A link to a .md file outside with a .md name: still outside.
        std::os::unix::fs::symlink(ws.join("README.md"), memory.join("readme.md")).unwrap();
        assert!(
            check(&at(&memory.join("readme.md")), &roots, &mem).is_ok(),
            "inside the worktree"
        );
        // A memory file reached through a link to the memory dir resolves to it.
        std::os::unix::fs::symlink(&memory, tmp.path().join("mem-link")).unwrap();
        assert!(check(&at(&tmp.path().join("mem-link/note.md")), &roots, &mem).is_ok());
    }

    #[test]
    fn the_hook_command_quotes_every_path() {
        let cmd = hook_command(
            Path::new("/Applications/Theodore Staging.app/Contents/MacOS/theodore"),
            &[PathBuf::from("/Users/o'neil/.theodore/spaces/a1")],
            &[],
        );
        assert_eq!(
            cmd,
            "'/Applications/Theodore Staging.app/Contents/MacOS/theodore' \
             --theodore-edit-guard '/Users/o'\\''neil/.theodore/spaces/a1'"
        );
        let cmd = hook_command(
            Path::new("/t"),
            &[PathBuf::from("/s/a1")],
            &[PathBuf::from("/Users/o'neil/.claude/projects/-s-a1/memory")],
        );
        assert_eq!(
            cmd,
            "'/t' --theodore-edit-guard '/s/a1' \
             '--memory=/Users/o'\\''neil/.claude/projects/-s-a1/memory'"
        );
    }
}
