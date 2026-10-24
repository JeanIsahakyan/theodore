//! Saving a project's config (docs/config.md "Creating and saving the
//! config"): one file committed on top of a branch tip in the bare cache,
//! and a single-file commit in a local folder.
//!
//! ```text
//! cache   hash-object ─▶ ls-tree / mktree per directory, bottom up ─▶ commit-tree
//!         (no worktree, no index, no ref moved; the caller pushes the sha)
//! folder  status (dirty paths) · add -- <path> ─▶ commit -- <path>  (your hooks)
//! ```

use std::path::Path;

use theodore_domain::Sha;
use theodore_ports::{GitError, GitResult, Identity};

use crate::GitCli;
use crate::process::GitProc;
use crate::safety::END_OF_OPTIONS;

fn proc<'a>(cwd: &'a Path, askpass: &'a Path, args: &'a [&'a str]) -> GitProc<'a> {
    GitProc {
        cwd,
        askpass,
        args,
        token: None,
        stdin: None,
    }
}

/// `path` as tree segments, refused when it could leave the repo or name
/// git's own directory.
pub(crate) fn segments(path: &str) -> GitResult<Vec<&str>> {
    let parts: Vec<&str> = path.split('/').collect();
    let ok = !path.is_empty()
        && parts
            .iter()
            .all(|p| !p.is_empty() && *p != "." && *p != ".." && *p != ".git" && !p.contains('\0'));
    if ok {
        Ok(parts)
    } else {
        Err(GitError::Parse(format!("bad path {path:?}")))
    }
}

/// One `ls-tree -z` entry: `<mode> <type> <oid>\t<name>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TreeEntry {
    pub mode: String,
    pub kind: String,
    pub oid: String,
    pub name: String,
}

pub(crate) fn parse_ls_tree(out: &[u8]) -> Vec<TreeEntry> {
    String::from_utf8_lossy(out)
        .split('\0')
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let (meta, name) = l.split_once('\t')?;
            let mut m = meta.split(' ');
            Some(TreeEntry {
                mode: m.next()?.to_string(),
                kind: m.next()?.to_string(),
                oid: m.next()?.to_string(),
                name: name.to_string(),
            })
        })
        .collect()
}

/// `entries` with `name` set to `entry`, as `mktree -z` input.
pub(crate) fn mktree_input(entries: &[TreeEntry], entry: TreeEntry) -> Vec<u8> {
    let mut out = Vec::new();
    for e in entries.iter().filter(|e| e.name != entry.name) {
        out.extend_from_slice(format!("{} {} {}\t{}\0", e.mode, e.kind, e.oid, e.name).as_bytes());
    }
    out.extend_from_slice(
        format!(
            "{} {} {}\t{}\0",
            entry.mode, entry.kind, entry.oid, entry.name
        )
        .as_bytes(),
    );
    out
}

/// `git status --porcelain=v1 -z` paths: `XY path`, a rename or copy also
/// followed by its source path.
pub(crate) fn parse_status_z(out: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(out);
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut paths = Vec::new();
    while let Some(f) = fields.next() {
        if f.len() < 4 {
            continue;
        }
        let (xy, path) = f.split_at(3);
        paths.push(path.to_string());
        if (xy.starts_with('R') || xy.starts_with('C'))
            && let Some(from) = fields.next()
        {
            paths.push(from.to_string());
        }
    }
    paths
}

impl GitCli {
    async fn ls_tree(&self, repo: &Path, askpass: &Path, tree: &str) -> GitResult<Vec<TreeEntry>> {
        let out = proc(repo, askpass, &["ls-tree", "-z", tree]).run().await?;
        Ok(parse_ls_tree(&out))
    }

    pub(crate) async fn commit_file_op(
        &self,
        repo: &Path,
        parent: &Sha,
        path: &str,
        content: &[u8],
        message: &str,
        author: &Identity,
    ) -> GitResult<Sha> {
        let segs = segments(path)?;
        let askpass = self.ensure_askpass()?;
        let blob = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["hash-object", "-w", "--stdin"],
            token: None,
            stdin: Some(content),
        }
        .run_text()
        .await?
        .trim()
        .to_string();
        // The tree of each directory on the way down, `None` past the
        // first one that doesn't exist yet.
        let root = format!("{}^{{tree}}", parent.as_str());
        let root = proc(repo, &askpass, &["rev-parse", "--verify", &root])
            .run_text()
            .await?
            .trim()
            .to_string();
        let mut trees: Vec<Option<String>> = vec![Some(root)];
        for seg in &segs[..segs.len() - 1] {
            let next = match trees.last().cloned().flatten() {
                Some(t) => self
                    .ls_tree(repo, &askpass, &t)
                    .await?
                    .into_iter()
                    .find(|e| e.name == *seg && e.kind == "tree")
                    .map(|e| e.oid),
                None => None,
            };
            trees.push(next);
        }
        let mut entry = TreeEntry {
            mode: "100644".into(),
            kind: "blob".into(),
            oid: blob,
            name: segs[segs.len() - 1].to_string(),
        };
        for depth in (0..segs.len()).rev() {
            let existing = match &trees[depth] {
                Some(t) => self.ls_tree(repo, &askpass, t).await?,
                None => Vec::new(),
            };
            let input = mktree_input(&existing, entry);
            let oid = GitProc {
                cwd: repo,
                askpass: &askpass,
                args: &["mktree", "-z"],
                token: None,
                stdin: Some(&input),
            }
            .run_text()
            .await?
            .trim()
            .to_string();
            entry = TreeEntry {
                mode: "040000".into(),
                kind: "tree".into(),
                oid,
                name: if depth > 0 {
                    segs[depth - 1].to_string()
                } else {
                    String::new()
                },
            };
        }
        let name = format!("user.name={}", author.name);
        let email = format!("user.email={}", author.email);
        // Unsigned: Theodore can't answer a passphrase prompt (same as a
        // shipped space, docs/spaces.md §6).
        let sha = proc(
            repo,
            &askpass,
            &[
                "-c",
                &name,
                "-c",
                &email,
                "-c",
                "commit.gpgsign=false",
                "commit-tree",
                &entry.oid,
                "-p",
                parent.as_str(),
                "-m",
                message,
            ],
        )
        .run_text()
        .await?
        .trim()
        .to_string();
        Ok(Sha::new(sha))
    }

    pub(crate) async fn dirty_paths_op(&self, folder: &Path) -> GitResult<Vec<String>> {
        let askpass = self.ensure_askpass()?;
        let out = proc(
            folder,
            &askpass,
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
            ],
        )
        .run()
        .await?;
        Ok(parse_status_z(&out))
    }

    pub(crate) async fn commit_paths_op(
        &self,
        folder: &Path,
        paths: &[String],
        message: &str,
    ) -> GitResult<Sha> {
        for p in paths {
            segments(p)?;
        }
        if paths.is_empty() {
            return Err(GitError::Parse("nothing to commit".into()));
        }
        let askpass = self.ensure_askpass()?;
        let mut add: Vec<&str> = vec!["add", END_OF_OPTIONS];
        add.extend(paths.iter().map(String::as_str));
        proc(folder, &askpass, &add).run().await?;
        // `commit -- <paths>` commits only those paths, whatever else is
        // staged; the user's hooks and identity apply as for any commit.
        let mut commit: Vec<&str> = vec!["commit", "-q", "-m", message, END_OF_OPTIONS];
        commit.extend(paths.iter().map(String::as_str));
        let out = proc(folder, &askpass, &commit).run_raw().await?;
        if out.status != 0 {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let why = if stderr.is_empty() { stdout } else { stderr };
            return Err(GitError::Refused(format!("git commit failed: {why}")));
        }
        let head = proc(folder, &askpass, &["rev-parse", "HEAD"])
            .run_text()
            .await?;
        Ok(Sha::new(head.trim().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_repo() {
        assert_eq!(
            segments(".theodore/config.yaml").unwrap(),
            vec![".theodore", "config.yaml"]
        );
        for bad in ["", "/abs", "a//b", "../x", "a/./b", ".git/config"] {
            assert!(segments(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn ls_tree_entries_round_trip_into_mktree_input() {
        let out = b"100644 blob aaa\tREADME.md\x00040000 tree bbb\t.theodore\0";
        let entries = parse_ls_tree(out);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].name, ".theodore");
        let input = mktree_input(
            &entries,
            TreeEntry {
                mode: "040000".into(),
                kind: "tree".into(),
                oid: "ccc".into(),
                name: ".theodore".into(),
            },
        );
        assert_eq!(
            String::from_utf8(input).unwrap(),
            "100644 blob aaa\tREADME.md\x00040000 tree ccc\t.theodore\0"
        );
    }

    #[test]
    fn status_lists_both_sides_of_a_rename() {
        let out = b" M a.txt\0R  new.txt\0old.txt\0?? .theodore/config.yaml\0";
        assert_eq!(
            parse_status_z(out),
            vec!["a.txt", "new.txt", "old.txt", ".theodore/config.yaml"]
        );
    }
}
