//! `git merge-tree --write-tree --name-only` (git >= 2.38): the conflicting
//! paths of merging `head` into `base`, with no worktree checkout and no
//! index changes (plan "conflicts").
//!
//! Output shape (confirmed against a real `git`, exit code is meaningful):
//! ```text
//! <result tree oid>
//! <conflicted path>
//! <conflicted path>
//! ...
//! <blank line>
//! Auto-merging <path>
//! CONFLICT (<kind>): <message mentioning the path>
//! ```
//! Exit 0 = clean merge, no further output. Exit 1 = conflicts, parsed
//! above. Anything else is a real error, except an unrecognized
//! `--write-tree`/`--name-only` on an old `git`, which is `Unsupported`.

use std::path::Path;

use theodore_domain::Sha;
use theodore_ports::{ConflictEntry, ConflictKind, GitError, GitResult};

use crate::GitCli;
use crate::process::{GitProc, RawOutput};

impl GitCli {
    pub(crate) async fn merge_tree_conflicts_op(
        &self,
        repo: &Path,
        base: &Sha,
        head: &Sha,
    ) -> GitResult<Vec<ConflictEntry>> {
        let askpass = self.ensure_askpass()?;
        let args = [
            "merge-tree",
            "--write-tree",
            "--name-only",
            base.as_str(),
            head.as_str(),
        ];
        let raw = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &args,
            token: None,
            stdin: None,
        }
        .run_raw()
        .await?;
        parse_merge_tree(&raw)
    }
}

fn parse_merge_tree(raw: &RawOutput) -> GitResult<Vec<ConflictEntry>> {
    match raw.status {
        0 => Ok(Vec::new()),
        // Exit 1 is ambiguous: a genuine conflict writes the tree oid and
        // conflict info to stdout with an empty stderr, but `git` also
        // exits 1 (empty stdout, an error on stderr) when `base`/`head`
        // don't resolve at all — that case must still surface as an error.
        1 if !raw.stdout.is_empty() => Ok(parse_conflicts(&String::from_utf8_lossy(&raw.stdout))),
        code => {
            let stderr = String::from_utf8_lossy(&raw.stderr).into_owned();
            if looks_unsupported(&stderr) {
                Err(GitError::Unsupported(
                    "merge-tree --write-tree (needs git >= 2.38)",
                ))
            } else {
                Err(GitError::Command {
                    args: "merge-tree --write-tree --name-only".into(),
                    code,
                    stderr,
                })
            }
        }
    }
}

fn looks_unsupported(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("unknown option")
        || s.contains("unknown switch")
        || s.contains("usage: git merge-tree")
}

/// Parses `--name-only` output: a tree oid, then one conflicted path per
/// line until a blank line, then `CONFLICT (<kind>): ...` message lines
/// (one or more per path) that a path's kind is read back off of.
fn parse_conflicts(text: &str) -> Vec<ConflictEntry> {
    let mut lines = text.lines();
    lines.next(); // result tree oid, unused: no worktree is written anywhere.
    let mut paths = Vec::new();
    for line in lines.by_ref() {
        if line.is_empty() {
            break;
        }
        paths.push(line.to_string());
    }
    let messages: Vec<&str> = lines.collect();
    paths
        .into_iter()
        .map(|path| {
            let kind = messages
                .iter()
                .find(|m| m.starts_with("CONFLICT (") && m.contains(path.as_str()))
                .and_then(|m| extract_kind(m))
                .unwrap_or(ConflictKind::Other);
            ConflictEntry { path, kind }
        })
        .collect()
}

fn extract_kind(message: &str) -> Option<ConflictKind> {
    let start = message.find('(')? + 1;
    let end = start + message[start..].find(')')?;
    Some(match &message[start..end] {
        "content" => ConflictKind::Content,
        "add/add" => ConflictKind::AddAdd,
        "modify/delete" => ConflictKind::ModifyDelete,
        "rename/delete" => ConflictKind::RenameDelete,
        "rename/rename" => ConflictKind::RenameRename,
        "directory/file" | "file/directory" => ConflictKind::DirectoryFile,
        "submodule" => ConflictKind::Submodule,
        _ => ConflictKind::Other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(status: i32, stdout: &str, stderr: &str) -> RawOutput {
        RawOutput {
            status,
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn clean_merge_has_no_conflicts() {
        let out = raw(0, "a92d0f7d18c58213cb6a04a8fb42980107af897d\n", "");
        assert_eq!(parse_merge_tree(&out).unwrap(), Vec::new());
    }

    #[test]
    fn content_conflict() {
        let out = raw(
            1,
            "a92d0f7d18c58213cb6a04a8fb42980107af897d\nf.txt\n\nAuto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n",
            "",
        );
        let entries = parse_merge_tree(&out).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "f.txt");
        assert_eq!(entries[0].kind, ConflictKind::Content);
    }

    #[test]
    fn add_add_conflict() {
        let out = raw(
            1,
            "0b82d1c2800585c13f845c1c55d86d44f17e76f1\naddadd.txt\n\nAuto-merging addadd.txt\nCONFLICT (add/add): Merge conflict in addadd.txt\n",
            "",
        );
        let entries = parse_merge_tree(&out).unwrap();
        assert_eq!(entries[0].kind, ConflictKind::AddAdd);
    }

    #[test]
    fn modify_delete_conflict_message_has_no_merge_conflict_phrase() {
        let out = raw(
            1,
            "af9d6a60a62b0d4259ce1d27ddd4405d8ff8ecb2\nmodme.txt\n\nCONFLICT (modify/delete): modme.txt deleted in 06b888f and modified in d9295af.  Version d9295af of modme.txt left in tree.\n",
            "",
        );
        let entries = parse_merge_tree(&out).unwrap();
        assert_eq!(entries[0].path, "modme.txt");
        assert_eq!(entries[0].kind, ConflictKind::ModifyDelete);
    }

    #[test]
    fn rename_delete_picks_the_first_matching_conflict_line() {
        // Two CONFLICT lines mention `renamed.txt`; the first (rename/delete)
        // wins, matching the order `git` reports them in.
        let out = raw(
            1,
            "5dde0ad85c7878c25b49b27b2c71d5daebff48ed\nrenamed.txt\n\nCONFLICT (rename/delete): orig.txt renamed to renamed.txt in X, but deleted in Y.\nCONFLICT (modify/delete): renamed.txt deleted in Y and modified in X.\n",
            "",
        );
        let entries = parse_merge_tree(&out).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, ConflictKind::RenameDelete);
    }

    #[test]
    fn multiple_conflicted_paths() {
        let out = raw(
            1,
            "treeoid\na.txt\nb.txt\n\nCONFLICT (content): Merge conflict in a.txt\nCONFLICT (content): Merge conflict in b.txt\n",
            "",
        );
        let entries = parse_merge_tree(&out).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "a.txt");
        assert_eq!(entries[1].path, "b.txt");
    }

    #[test]
    fn unknown_option_on_an_old_git_is_unsupported() {
        let out = raw(
            129,
            "",
            "error: unknown option `write-tree'\nusage: git merge-tree <base-tree> <branch1> <branch2>\n",
        );
        assert!(matches!(
            parse_merge_tree(&out),
            Err(GitError::Unsupported(_))
        ));
    }

    #[test]
    fn a_real_error_stays_a_command_error() {
        let out = raw(128, "", "fatal: not a valid object name deadbeef\n");
        assert!(matches!(
            parse_merge_tree(&out),
            Err(GitError::Command { .. })
        ));
    }

    /// `git merge-tree` also exits 1 (not just a special code) when `base`
    /// or `head` don't resolve — distinguished from a genuine conflict only
    /// by stdout being empty.
    #[test]
    fn exit_1_with_empty_stdout_is_a_resolution_error_not_a_conflict() {
        let out = raw(1, "", "merge-tree: deadbeef - not something we can merge\n");
        assert!(matches!(
            parse_merge_tree(&out),
            Err(GitError::Command { .. })
        ));
    }
}
