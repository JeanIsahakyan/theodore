//! Credential handling: tokens never touch argv, a clone URL, or `.git/config`.
//!
//! `GIT_ASKPASS` points at a small helper script that this module writes once
//! under `<root>/`. The script itself holds no secret — it reads the token
//! from `THEODORE_GIT_TOKEN`, an env var set only on the child `git` process
//! for the single call that needs it (see `process.rs`).

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use theodore_domain::HostKind;
use theodore_ports::GitResult;

const ASKPASS_NAME: &str = ".askpass.sh";

const ASKPASS_SCRIPT: &str = "#!/bin/sh\n\
# Written by theodore-git. Holds no secret: reads the token from an env var\n\
# set only on the git child process that needed it.\n\
case \"$1\" in\n\
  Username*) printf '%s' \"${THEODORE_GIT_USER:-x-access-token}\" ;;\n\
  *) printf '%s' \"${THEODORE_GIT_TOKEN:-}\" ;;\n\
esac\n";

/// Write the askpass helper under `root` if missing or stale. Returns its path.
pub(crate) fn ensure_askpass(root: &Path) -> GitResult<PathBuf> {
    std::fs::create_dir_all(root)?;
    let path = root.join(ASKPASS_NAME);
    let current = std::fs::read_to_string(&path).ok();
    if current.as_deref() != Some(ASKPASS_SCRIPT) {
        let tmp = root.join(".askpass.sh.tmp");
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(ASKPASS_SCRIPT.as_bytes())?;
        }
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o700))?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(path)
}

/// Clone URL for a host-neutral repo ref. Never carries a credential.
pub(crate) fn clone_url(host: HostKind, owner: &str, name: &str) -> Option<String> {
    let domain = match host {
        HostKind::Github => "github.com",
        HostKind::Gitlab => "gitlab.com",
        HostKind::Bitbucket => "bitbucket.org",
        HostKind::Local => return None,
    };
    Some(format!("https://{domain}/{owner}/{name}.git"))
}

/// Host directory segment under `<root>/repos/<host>/...` (also used as the
/// leading component of a worktree directory name).
pub(crate) fn host_dir(host: HostKind) -> &'static str {
    match host {
        HostKind::Github => "github",
        HostKind::Gitlab => "gitlab",
        HostKind::Bitbucket => "bitbucket",
        HostKind::Local => "local",
    }
}

/// Remote ref that carries a PR/MR's head commit, host-dependent.
pub(crate) fn remote_pr_ref(host: HostKind, number: u64) -> String {
    match host {
        HostKind::Github => format!("refs/pull/{number}/head"),
        HostKind::Gitlab => format!("refs/merge-requests/{number}/head"),
        HostKind::Bitbucket => format!("refs/pull-requests/{number}/from"),
        HostKind::Local => format!("refs/heads/pr-{number}"),
    }
}

/// Local ref theodore fetches a PR's head into, so repeated fetches are a
/// cheap no-op and the sha survives a `gc`.
pub(crate) fn local_pr_ref(number: u64) -> String {
    format!("refs/theodore/pr/{number}")
}
