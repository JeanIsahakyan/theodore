//! Shared by the integration tests: a `git` command that sees nothing of
//! the machine it runs on.
//!
//! The system and global config stay out (`GIT_CONFIG_NOSYSTEM`,
//! `GIT_CONFIG_GLOBAL`): CI has no global identity ("Author identity
//! unknown"), a developer's machine has hooks, signing and a commit
//! template. The identity the tests commit with comes from a global config
//! file of their own, so a repo's `git config` and a `-c` still override
//! it, as a user's would. All of it per command: `std::env::set_var` is
//! process-wide and would race the other tests of the binary.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const GLOBAL_CONFIG: &str = "\
[user]
\tname = test
\temail = a@b.com
[commit]
\tgpgsign = false
[core]
\thooksPath = /dev/null
[init]
\tdefaultBranch = main
";

static CONFIG: OnceLock<PathBuf> = OnceLock::new();

/// The tests' global git config, written once per binary into cargo's
/// scratch dir for this crate's tests. Other test binaries write the same
/// bytes; the rename keeps a reader from seeing a half-written file.
fn global_config() -> &'static Path {
    CONFIG.get_or_init(|| {
        let dir = Path::new(env!("CARGO_TARGET_TMPDIR"));
        std::fs::create_dir_all(dir).expect("cargo's test scratch dir");
        let file = dir.join("gitconfig");
        let tmp = dir.join(format!("gitconfig.{}", std::process::id()));
        std::fs::write(&tmp, GLOBAL_CONFIG).expect("write the test git config");
        std::fs::rename(&tmp, &file).expect("place the test git config");
        file
    })
}

/// `git` in `dir`, hermetic: no system or global config but the tests'
/// own, no inherited repo location, no prompts.
pub fn git_cmd(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", global_config())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C");
    for var in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
    ] {
        cmd.env_remove(var);
    }
    cmd
}
