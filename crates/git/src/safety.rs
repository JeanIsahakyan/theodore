//! Path and argv safety for host-supplied identifiers: a `RepoRef`'s
//! `owner`/`name` become directory names (`repo_dir`, the worktree
//! dirname), and a branch/ref name can reach `git` as a bare positional
//! argument. Neither is trustworthy — a GitHub repo owner, a GitLab
//! namespace, or a fork's branch name is chosen by whoever owns that
//! remote, not by Theodore.

use theodore_domain::RepoRef;
use theodore_ports::{GitError, GitResult};

/// One path segment: a directory or file name. Rejects anything that could
/// escape its parent directory (`..`, a separator) or be mistaken for a
/// flag by a tool that parses it as an argument (a leading `-`).
fn validate_component(s: &str) -> GitResult<()> {
    if s.is_empty() {
        return Err(GitError::Parse("empty path component".to_string()));
    }
    if s == "." || s == ".." {
        return Err(GitError::Parse(format!("unsafe path component: {s:?}")));
    }
    if s.contains('/') || s.contains('\\') {
        return Err(GitError::Parse(format!(
            "path component contains a separator: {s:?}"
        )));
    }
    if s.starts_with('-') {
        return Err(GitError::Parse(format!(
            "path component looks like a flag: {s:?}"
        )));
    }
    if s.contains('\0') {
        return Err(GitError::Parse(
            "path component contains a NUL byte".to_string(),
        ));
    }
    Ok(())
}

/// `RepoRef::owner`: a single safe segment, or (GitLab subgroups) several
/// `/`-separated segments, each validated on its own — only the separator
/// itself is allowed through unchecked.
fn validate_owner(owner: &str) -> GitResult<()> {
    if owner.is_empty() {
        return Err(GitError::Parse("empty owner".to_string()));
    }
    for segment in owner.split('/') {
        validate_component(segment)?;
    }
    Ok(())
}

/// Checked before `owner`/`name` are turned into any path or directory
/// name (`GitCli::repo_dir`, `GitCli::wt_dirname`).
pub(crate) fn validate_repo_ref(repo: &RepoRef) -> GitResult<()> {
    validate_owner(&repo.owner)?;
    validate_component(&repo.name)
}

/// Git stops parsing options at a literal `--end-of-options` (supported by
/// every subcommand used here since git 2.24): everything after it is a
/// positional argument, never a flag, no matter what it starts with. Use
/// this immediately before any single ref/branch argument that came from
/// outside Theodore (a fork's branch name, a local project's branch) so a
/// name like `--upload-pack=...` can't be read as an option.
pub(crate) const END_OF_OPTIONS: &str = "--end-of-options";

#[cfg(test)]
mod tests {
    use super::*;
    use theodore_domain::HostKind;

    fn repo(owner: &str, name: &str) -> RepoRef {
        RepoRef {
            host: HostKind::Github,
            owner: owner.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn plain_owner_and_name_are_fine() {
        assert!(validate_repo_ref(&repo("acme", "widgets")).is_ok());
    }

    #[test]
    fn gitlab_style_namespaced_owner_is_fine() {
        assert!(validate_repo_ref(&repo("group/subgroup", "widgets")).is_ok());
    }

    #[test]
    fn dotdot_is_rejected_in_owner_or_name() {
        assert!(validate_repo_ref(&repo("..", "widgets")).is_err());
        assert!(validate_repo_ref(&repo("acme", "..")).is_err());
        assert!(validate_repo_ref(&repo("acme/..", "widgets")).is_err());
    }

    #[test]
    fn leading_dash_is_rejected() {
        assert!(validate_repo_ref(&repo("-acme", "widgets")).is_err());
        assert!(validate_repo_ref(&repo("acme", "-widgets")).is_err());
    }

    #[test]
    fn empty_owner_or_name_is_rejected() {
        assert!(validate_repo_ref(&repo("", "widgets")).is_err());
        assert!(validate_repo_ref(&repo("acme", "")).is_err());
    }

    #[test]
    fn separator_in_name_is_rejected() {
        assert!(validate_repo_ref(&repo("acme", "wid/gets")).is_err());
    }
}
