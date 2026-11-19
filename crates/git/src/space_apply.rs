//! Bringing another space's change into a space's worktree (docs/spaces.md
//! "Sub-spaces", `space_merge`): three-way, as uncommitted edits.
//!
//! ```text
//! worktree now ─(temp index, as a checkpoint)─▶ ours (a commit, no ref)
//! merge-tree --write-tree --merge-base <from> <ours> <to> ─▶ merged tree
//!            (conflicts: markers inside the merged files, paths listed)
//! diff-tree ours merged ─▶ rm what merged lacks, checkout-index what differs
//!                          (temp index: HEAD, index and refs stay)
//! conflicted files ─▶ marker labels: the commits' shas ─▶ `ours` / `theirs`
//! ```

use std::path::Path;

use theodore_domain::Sha;
use theodore_ports::{FileStat, GitError, GitResult, SpaceApply};

use crate::GitCli;
use crate::checkpoints::{
    changed_paths, commit_tree, git_dir, must_rev, remove_file, through_symlink, worktree_tree,
    write_paths,
};
use crate::parse;
use crate::ship::{conflicted_paths, stderr_of};

impl GitCli {
    pub(crate) async fn space_apply_op(
        &self,
        worktree: &Path,
        from: &Sha,
        to: &Sha,
        ours: &str,
        theirs: &str,
    ) -> GitResult<SpaceApply> {
        let askpass = self.ensure_askpass()?;
        let _wt = crate::locks::lock(worktree).await;
        let git = self.space_git(worktree, &askpass);
        git.verify_root().await?;
        // Half a rebase or merge there: the user's (or agent's) to finish.
        if let Some(busy) = git.busy().await? {
            return Err(GitError::Busy(busy));
        }
        let from = must_rev(&git, &format!("{}^{{commit}}", from.as_str())).await?;
        let to = must_rev(&git, &format!("{}^{{commit}}", to.as_str())).await?;
        let git_dir = git_dir(&git).await?;
        let head = must_rev(&git, "HEAD").await?;
        let now = worktree_tree(&git, &git_dir).await?;
        // merge-tree merges commits: the worktree as one, on `HEAD`, no ref.
        let snap = if must_rev(&git, "HEAD^{tree}").await? == now {
            head
        } else {
            commit_tree(&git, &now, &head, "snapshot of the worktree", None).await?
        };
        let out = git
            .run_raw(&[
                "merge-tree",
                "--write-tree",
                "--name-only",
                "--no-messages",
                "--merge-base",
                &from,
                &snap,
                &to,
            ])
            .await?;
        let conflicts = match out.status {
            0 => Vec::new(),
            1 => conflicted_paths(&out.stdout),
            code => {
                return Err(GitError::Command {
                    args: "merge-tree --write-tree".into(),
                    code,
                    stderr: stderr_of(&out),
                });
            }
        };
        let merged = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        if merged.is_empty() {
            return Err(GitError::Parse("merge-tree wrote no tree".into()));
        }
        if merged == now {
            return Ok(SpaceApply {
                files: Vec::new(),
                conflicts,
            });
        }
        let (write, remove) = changed_paths(&git, &now, &merged).await?;
        // Removed first: a file may give way to a directory and back.
        for p in &remove {
            remove_file(worktree, Path::new(p))?;
        }
        write_paths(&git, &git_dir, &merged, &write).await?;
        let labels = [
            ("<<<<<<< ", snap.as_str(), ours),
            ("||||||| ", from.as_str(), "base"),
            (">>>>>>> ", to.as_str(), theirs),
        ];
        for p in &conflicts {
            relabel_file(worktree, p, &labels);
        }
        let stat = git
            .run(&[
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--find-renames",
                "--numstat",
                "-z",
                &now,
                &merged,
            ])
            .await?;
        let files = parse::parse_numstat(&stat)
            .into_iter()
            .map(|n| FileStat {
                path: n.path,
                additions: n.additions.unwrap_or(0),
                deletions: n.deletions.unwrap_or(0),
            })
            .collect();
        Ok(SpaceApply { files, conflicts })
    }
}

/// Rewrites the conflict markers' labels in the file at `rel`: git names
/// each side by the commit given, a sha that tells the agent nothing.
/// Best effort: a file that can't be read or written keeps git's labels.
fn relabel_file(root: &Path, rel: &str, labels: &[(&str, &str, &str)]) {
    let rel = Path::new(rel);
    if through_symlink(root, rel) {
        return;
    }
    let path = root.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&path) else {
        return;
    };
    if !meta.is_file() {
        return;
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return;
    };
    if let Some(out) = relabel(&bytes, labels) {
        let _ = std::fs::write(&path, out);
    }
}

/// `bytes` with each marker line `<marker><sha>[:<path>]` made
/// `<marker><label>[:<path>]`; `None` when no line changed.
fn relabel(bytes: &[u8], labels: &[(&str, &str, &str)]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut changed = false;
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        let hit = labels.iter().find_map(|(marker, sha, label)| {
            let prefix = format!("{marker}{sha}");
            let rest = line.strip_prefix(prefix.as_bytes())?;
            matches!(rest.first(), None | Some(b'\n' | b'\r' | b':'))
                .then_some((marker, label, rest))
        });
        match hit {
            Some((marker, label, rest)) => {
                out.extend_from_slice(marker.as_bytes());
                out.extend_from_slice(label.as_bytes());
                out.extend_from_slice(rest);
                changed = true;
            }
            None => out.extend_from_slice(line),
        }
    }
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::relabel;

    #[test]
    fn marker_labels_are_replaced_and_nothing_else() {
        let text = "a\n<<<<<<< aaa\nx\n||||||| bbb:old.rs\ny\n=======\nz\n>>>>>>> ccc\n\
                    <<<<<<< aaab\n";
        let labels = [
            ("<<<<<<< ", "aaa", "this space"),
            ("||||||| ", "bbb", "base"),
            (">>>>>>> ", "ccc", "sub-space s"),
        ];
        let out = String::from_utf8(relabel(text.as_bytes(), &labels).unwrap()).unwrap();
        assert_eq!(
            out,
            "a\n<<<<<<< this space\nx\n||||||| base:old.rs\ny\n=======\nz\n\
             >>>>>>> sub-space s\n<<<<<<< aaab\n"
        );
        assert_eq!(relabel(b"plain\n", &labels), None);
    }
}
